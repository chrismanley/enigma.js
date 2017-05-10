import Events from '../../event-emitter';
import ApiCache from './api-cache';

const RETURN_KEY = 'qReturn';
const MANUAL_SUSPEND = 4000;
const ON_ATTACHED_TIMEOUT = 5000;
const hasOwnProperty = Object.prototype.hasOwnProperty;

let connectionIdCounter = 0;
/**
* Session - Handles a session against an endpoint
*/
class Session {

  /**
   * Constructor
   * @param {Object} rpc - The RPC instance used by the session.
   * @param {Boolean} delta=true - Flag to determine delta handling.
   * @param {Object} definition - The definition instance used by the session.
   * @param {Object} JSONPatch - JSON patch object.
   * @param {Function} Promise - The promise constructor.
   * @param {Object} listeners - A key-value map of listeners.
   * @param {Array} interceptors - An array of interceptors.
   * @param {Function} handleLog - log handler callback
   * @param {String} appId - the appId for this session.
   * @param {Boolean} noData - if true, the app was opened without data.
   * @param {Boolean} suspendOnClose - when true, the session will be suspended if the underlying
   *                                   websocket closes unexpectedly.
   */
  constructor(rpc, delta, definition, JSONPatch, Promise, listeners = {},
    interceptors = [], handleLog, appId, noData, suspendOnClose) {
    Events.mixin(this);
    this.rpc = rpc;
    this.delta = delta;
    this.definition = definition;
    this.JSONPatch = JSONPatch;
    this.Promise = Promise;
    this.apis = new ApiCache();
    this.handleLog = handleLog;
    this.appId = appId;
    this.noData = noData;
    this.suspendOnClose = suspendOnClose;
    this.connectionId = connectionIdCounter += 1;
    this.responseInterceptors = [{
      onFulfilled: this.processLogInterceptor,
    }, {
      onFulfilled: this.processErrorInterceptor,
    }, {
      onFulfilled: this.processDeltaInterceptor,
    }, {
      onFulfilled: this.processResultInterceptor,
    }, {
      onFulfilled: this.processOutInterceptor,
    }, {
      onFulfilled: this.processObjectApiInterceptor,
    }];
    this.responseInterceptors.push(...interceptors);
    this.registerRpcListeners();

    this.rpc.on('notification', (response) => {
      this.emit('notification:*', response.method, response.params);
      this.emit(`notification:${response.method}`, response.params);
    });

    this.suspended = false;

    this.on('handle-changed', (handle) => {
      const api = this.apis.getApi(handle);
      if (api) {
        api.emit('changed');
      }
    });

    this.on('handle-closed', (handle) => {
      const api = this.apis.getApi(handle);
      if (api) {
        api.emit('closed');
        this.apis.remove(handle);
      }
    });

    this.on('suspended', () => {
      this.suspended = true;
    });

    this.on('closed', () => {
      this.removeAllListeners();
      this.apis.getApis().forEach((entry) => {
        entry.api.emit('closed');
        entry.api.removeAllListeners();
      });
      this.apis.clear();
    });

    Object.keys(listeners).forEach(key => this.on(key, listeners[key]));
    this.emit('session-created', this);
  }

  // TODO: Rename as this does not register the notification listerners.
  /**
  * Function used register the RPC listerners except for the notification listeners
  */
  registerRpcListeners() {
    this.rpc.on('socket-error', err => this.emit('socket-error', err));
    this.rpc.on('closed', (evt) => {
      if ((this.suspendOnClose && evt.code !== 1000) || evt.code === MANUAL_SUSPEND) {
        this.emit('suspended',
          { initiator: evt.code === MANUAL_SUSPEND ? 'manual' : 'network' });
      } else {
        this.emit('closed', evt);
      }
    });

    this.rpc.on('message', (response) => {
      if (response.change) {
        response.change.forEach(handle => this.emit('handle-changed', handle));
      }

      if (response.close) {
        response.close.forEach(handle => this.emit('handle-closed', handle));
      }
    });
  }

  // TODO: Rename as this does not unregister the notification listerners.
  /**
  * Function used unregister the RPC listerners except for the notification listeners
  */
  unregisterRpcListeners() {
    this.rpc.removeAllListeners('socket-error');
    this.rpc.removeAllListeners('closed');
    this.rpc.removeAllListeners('message');
  }

  /**
  * Function used to connect to the endpoint.
  * @returns {Object} Returns a promise instance.
  */
  connect() {
    return this.rpc.open();
  }

  /**
  * Function used to send data to the endpoint.
  * @param {Object} request - The request to be sent. (data and some meta info)
  * @returns {Object} Returns a promise instance.
  */
  send(request) {
    if (this.suspended) {
      return this.Promise.reject(new Error('Session suspended'));
    }

    const data = {
      method: request.method,
      handle: request.handle,
      params: request.params,
      delta: request.delta,
      // TODO: add cont & return_empty when needed/used
    };
    const response = this.rpc.send(data);
    request.id = data.id;

    if (this.handleLog) { // Log after the request is sent to get the request id into the logs
      this.handleLog({ msg: 'Sent', connection: this.connectionId, data: request });
    }

    const promise = this.intercept(response, this.responseInterceptors, request);
    Session.addToPromiseChain(promise, 'requestId', request.id);
    return promise;
  }

  /**
  * Function used to suspend the session.
  * @returns {Object} Returns a promise instance.
  */
  suspend() {
    return this.rpc.close(MANUAL_SUSPEND);
  }

  /**
  * Function used to restore the global API.
  * @param {Object} restoredApis - The API-cache containing restored APIs.
  * @returns {Object} Returns a promise instance.
  */
  restoreGlobal(restoredApis) {
    const global = this.apis.getApisByType('Global').pop();
    restoredApis.add(global.handle, global.api);
    return this.Promise.resolve();
  }

  /**
  * Function used to restore the doc API.
  * @param {String} sessionState - The state of the session, attached or created.
  * @param {Object} restoredApis - The API-cache containing restored APIs.
  * @returns {Object} Returns a promise instance.
  */
  restoreDoc(sessionState, restoredApis) {
    const app = this.apis.getApisByType('Doc').pop();
    if (!app) {
      return this.Promise.resolve();
    }

    const attached = sessionState === 'SESSION_ATTACHED';
    const method = attached ? 'GetActiveDoc' : 'OpenDoc';
    const params = attached ? [] : [this.appId, '', '', '', !!this.noData];
    const request = {
      method,
      handle: -1,
      params,
    };

    return this.rpc.send(request)
      .then((response) => {
        if (response.error) {
          return this.Promise.reject(new Error(response.error.message));
        }

        const handle = response.result.qReturn.qHandle;
        app.api.handle = handle;
        restoredApis.add(handle, app.api);
        return this.Promise.resolve(app.api);
      });
  }

  /**
  * Function used to restore the APIs on the doc.
  * @param {Object} doc - The doc API on which the APIs we want to restore exist.
  * @param {Object} restoredApis - The API-cache containing restored APIs.
  * @param {Array} closed - A list of APIs that has been closed when resuming the session.
  * @returns {Object} Returns a promise instance.
  */
  restoreDocObjects(doc, restoredApis, closed) {
    const tasks = [];

    const entries = this.apis.getApis().filter(entry => entry.api.type !== 'Global' && entry.api.type !== 'Doc');

    entries.forEach((entry) => {
      const api = entry.api;
      const method = api.getMethodName;

      if (!method) {
        closed.push(api);
      } else {
        const request = this.rpc.send({
          method,
          handle: doc.handle,
          params: [api.id],
        })
        .then((response) => {
          if (response.error || !response.result.qReturn.qHandle) {
            closed.push(api);
          } else {
            api.handle = response.result.qReturn.qHandle;
            restoredApis.add(api.handle, api);
          }
        });
        tasks.push(request);
      }
    });
    return Promise.all(tasks);
  }

  /**
  * Function used to resume the session
  * @param {Boolean} onlyIfAttached - if true, resume only if the session was re-attached.
  * @returns {Object} Returns a promise instance.
  */
  resume(onlyIfAttached) {
    if (!this.suspended) {
      return this.Promise.reject(new Error('Not suspended'));
    }

    this.unregisterRpcListeners();
    const restoredApis = new ApiCache();
    const closed = [];

    return this.rpc.reopen(ON_ATTACHED_TIMEOUT)
      .then((sessionState) => {
        if (sessionState === 'SESSION_CREATED' && onlyIfAttached) {
          return this.Promise.reject(new Error('Not attached'));
        }
        return this.Promise.resolve(sessionState);
      })
      .then(sessionState => this.restoreGlobal(restoredApis)
        .then(() => this.restoreDoc(sessionState, restoredApis))
        .then((doc) => {
          if (doc) {
            return this.restoreDocObjects(doc, restoredApis, closed);
          }
          return this.Promise.resolve();
        })
      )
      .then(() => {
        this.apis = restoredApis;
        this.suspended = false;
        this.registerRpcListeners();
        closed.forEach(api => api.emit('closed'));
        this.apis.getApis().filter(entry => entry.api.type !== 'Global').forEach((entry) => {
          entry.api.emit('changed');
        });
        this.emit('resumed');
      })
      .catch(err => this.rpc.close().then(() => {
        this.registerRpcListeners();
        return this.Promise.reject(err);
      }));
  }

  /**
  * Function used to close the endpoint.
  * @returns {Object} Returns a promise instance.
  */
  close() {
    return this.rpc.close();
  }

  /**
  * Function used to get an API for a backend object.
  * @param {Object} args - Arguments used to create object API.
  * @param {Number} args.handle - Handle of the backend object.
  * @param {String} args.id - ID of the backend object.
  * @param {String} args.type - QIX type of the backend object. Can for example
  *                             be "Doc" or "GenericVariable".
  * @param {String} args.customType - Custom type of the backend object, if defined in qInfo.
  * @param {Boolean} [args.delta=true] - Flag indicating if delta should be used or not.
  * @returns {*} Returns the generated and possibly augmented API.
  */
  getObjectApi(args) {
    const { handle, id, type, customType, delta = true } = args;
    let api = this.apis.getApi(handle);
    if (api) {
      return api;
    }
    api = this.definition
    .generate(type)
    .create(this, handle, id, delta, customType);
    this.apis.add(handle, api);
    return api;
  }

  /**
  * Function used to determine if it is a primitive patch.
  * @param  {Array}  patches Patches from engine.
  * @return {Boolean} Returns true if it is a primitive patch.
  */
  isPrimitivePatch(patches) {
    // It's only `add` and `replace` that has a
    // value property according to the jsonpatch spec
    return patches.length === 1 &&
    ['add', 'replace'].indexOf(patches[0].op) !== -1 &&
    this.isPrimitiveValue(patches[0].value) &&
    patches[0].path === '/';
  }

  /**
  * Function used to determine if it is a primitive value.
  * @param  {Any} value.
  * @return {Boolean} Returns true if it is a primitive value.
  */
  isPrimitiveValue(value) {
    return typeof value !== 'undefined' && value !== null && typeof value !== 'object' && !Array.isArray(value);
  }

  /**
  * Function used to get a patchee.
  * @param {Number} handle - The handle.
  * @param {Array} patches - The patches.
  * @param {String} cacheId - The cacheId.
  * @returns {Object} Returns the patchee.
  */
  getPatchee(handle, patches, cacheId) {
    // handle primitive types, e.g. string, int, bool
    if (this.isPrimitivePatch(patches)) {
      const value = patches[0].value;
      this.apis.setPatchee(handle, cacheId, value);
      return value;
    }

    let patchee = this.apis.getPatchee(handle, cacheId);

    if (!this.isPrimitiveValue(patchee)) {
      patchee = patchee || (patches.length && Array.isArray(patches[0].value) ? [] : {});
      this.applyPatch(patchee, patches);
    }

    this.apis.setPatchee(handle, cacheId, patchee);

    return patchee;
  }

  /**
  * Function used to apply a patch.
  * @param {Object} patchee - The object to patch.
  * @param {Array} patches - The list of patches to apply.
  */
  applyPatch(patchee, patches) {
    this.JSONPatch.apply(patchee, patches);
  }

  /**
  * Function used to intercept a request and apply interceptors.
  * @param {Object} promise - A Promise instance that holds the request to intercept.
  * @param {Array<Object>} interceptors - Array of objects with onFulfilled
  *                                       function and onReject function
  * that will be applied to a request.
  * @returns {Promise} Returns a promise.
  */
  intercept(promise, interceptors, meta) {
    return interceptors.reduce((interception, interceptor) =>
      interception.then(
      interceptor.onFulfilled && interceptor.onFulfilled.bind(this, meta),
      interceptor.onRejected && interceptor.onRejected.bind(this, meta))
      , promise
    );
  }

  /**
   * Log interceptor.
   * @param {Object} meta - The meta info about the request.
   * @param response - The response.
   * @returns {Object} - Returns the defined error for an error, else the response.
   */
  processLogInterceptor(meta, response) {
    if (this.handleLog) {
      this.handleLog({ msg: 'Received', connection: this.connectionId, data: response });
    }
    return response;
  }


  /**
  * Process error interceptor.
  * @param {Object} meta - The meta info about the request.
  * @param response - The response.
  * @returns {Object} - Returns the defined error for an error, else the response.
  */
  processErrorInterceptor(meta, response) {
    if (typeof response.error !== 'undefined') {
      this.emit('qix-error', response.error);
      return this.Promise.reject(response.error);
    }
    return response;
  }

  /**
  * Process delta interceptor.
  * @param {Object} meta - The meta info about the request.
  * @param response - The response.
  * @returns {Object} - Returns the patched response
  */
  processDeltaInterceptor(meta, response) {
    const result = response.result;
    if (response.delta) {
      // when delta is on the response data is expected to be an array of patches
      const keys = Object.keys(result);
      for (let i = 0, cnt = keys.length; i < cnt; i += 1) {
        const key = keys[i];
        const patches = result[key];
        if (!Array.isArray(patches)) {
          return this.Promise.reject('Unexpected rpc response, expected array of patches');
        }
        result[key] = this.getPatchee(meta.handle, patches, `${meta.method}-${key}`);
      }
      // return a cloned response object to avoid patched object references:
      return JSON.parse(JSON.stringify(response));
    }
    return response;
  }

  /**
  * Process result interceptor.
  * @param {Object} meta - The meta info about the request.
  * @param response - The response.
  * @returns {Object} - Returns the result property on the response
  */
  processResultInterceptor(meta, response) {
    return response.result;
  }

  /**
  * Process out interceptor.
  * @param {Object} meta - The meta info about the request.
  * @param response - The result.
  * @returns {Object} - Returns the out property on result
  */
  processOutInterceptor(meta, result) {
    if (hasOwnProperty.call(result, RETURN_KEY)) {
      return result[RETURN_KEY];
    } else if (meta.outKey !== -1) {
      return result[meta.outKey];
    }
    return result;
  }

  /**
  * Function used to process the object API interceptor.
  * @param {Object} meta - The meta info about the request.
  * @param response - The response.
  * @returns {Object} - Returns an object API or the response.
  */
  processObjectApiInterceptor(meta, response) {
    if (response.qHandle && response.qType) {
      const args = {
        handle: response.qHandle,
        type: response.qType,
        id: response.qGenericId,
        customType: response.qGenericType,
        delta: this.delta,
      };
      return this.getObjectApi(args);
    } else if (response.qHandle === null && response.qType === null) {
      return null;
    }
    return response;
  }

  /**
  * Function used to add info on the promise chain.
  * @private
  * @param {Promise} promise The promise to add info on.
  * @param {String} name    The property to add info on.
  * @param {Any} value   The info to add.
  */
  static addToPromiseChain(promise, name, value) {
    promise[name] = value;
    const then = promise.then;
    promise.then = function patchedThen(...params) {
      const chain = then.apply(this, params);
      Session.addToPromiseChain(chain, name, value);
      return chain;
    };
  }
}

export default Session;
