import {EventEmitter} from "events";
import {Method} from "./method";
import {TransportContext, Dispatcher, Message, MT_SIGNAL, MT_RPC, MT_INTERNAL} from "./defines";
import {createError, ErrorCodes} from "./errors";
import {makeInternalMessage, makeRequestMessage, makeSignalMessage, nextId} from "./utils";

export const MSG_RESOLVE = "resolve";
export const MSG_REJECT = "reject";
export const MSG_ERROR = "error";

export interface Listener<T> {
  (event: T): any;
}

export interface Disposable {
  dispose(): void;
}

export interface Transaction {
  id: number;
  hTimeout?: any;

  resolve(result: any): void;

  reject(error: string): void;
}

export class Provider extends EventEmitter {
  private _signals = new EventEmitter();
  private _methods: { [id: string]: Method } = {};
  private _txs: { [id: number]: Transaction } = {};

  protected _dispatch?: Dispatcher;
  protected _timeout: number = 0;

  constructor(dispatch?: Dispatcher | null, timeout?: number) {
    super();
    this._dispatch = dispatch ? dispatch : undefined;
    this._timeout = timeout || 0;
  }

  dispatch(message: Message, context?: TransportContext) {
    if (!this._dispatch) {
      throw new Error('Not implemented');
    }
    return this._dispatch(message, context);
  }

  error(code?: number, message?: string, data?: any) {
    return createError(code, message, data);
  }

  method(name: string, definition: any): void {
    const isMethod = definition instanceof Method;
    const isFunction = typeof definition === 'function';

    // a valid method is either a function or a client (relayed method)
    if (!isMethod && !isFunction) {
      return;
      // throw new TypeError('method definition must be either a function or an instance of Method');
    }

    if (/^rpc\./.test(name)) {
      throw new TypeError('"' + name + '" is a reserved method name');
    }

    // make instance of jayson.Method
    if (!isMethod) {
      definition = new Method(definition, {});
    }

    this._methods[name] = definition;
  }

  methods(methods: { [name: string]: Function }): this {
    methods = methods || {};

    for (const name in methods) {
      this.method(name, methods[name]);
    }

    return this;
  }

  hasMethod(name: string): boolean {
    return name in this._methods;
  }

  removeMethod(name: string): void {
    if (this.hasMethod(name)) {
      delete this._methods[name];
    }
  }

  onSignal(signal: string | symbol, listener: Listener<any>): Disposable {
    this._signals.on(signal, listener);
    return {
      dispose: () => this.offSignal(signal, listener)
    };
  }

  offSignal(signal: string | symbol, listener: Listener<any>) {
    return this._signals.removeListener(signal, listener);
  }

  offAllSignals(signal?: string | symbol) {
    return this._signals.removeAllListeners(signal);
  }

  async call(name: string, params: any): Promise<any> {
    if (!this._methods[name]) {
      throw new Error(`invalid method ${name}`);
    }

    return await this._methods[name].execute(this, params);
  }

  handle(message: Message, context?: TransportContext): void {
    switch (message.type) {
      case MT_SIGNAL:
        return this._handleSignal(message, context);

      case MT_RPC:
        return this._handelRequest(message, context);

      case MT_INTERNAL:
        return this._handleInternal(message, context);

      default:
        return this._raiseError(`invalid message type ${message.type}`, undefined, context);
    }
  }

  request<T, U>(method: string, params?: T, options?: any | number): Promise<U> {
    return new Promise((resolve, reject) => {
      if (typeof options === 'number') {
        options = {timeout: options}
      }
      options = options || {};
      const timeout = options.timeout != null ? options.timeout : this._timeout;

      const id = nextId();

      const transaction = this._txs[id] = {
        id,
        resolve,
        reject
      };

      if (timeout > 0) {
        this._txs[id].hTimeout = setTimeout(() => this._handleTimeout(transaction), timeout);
      }

      this.dispatch(makeRequestMessage(method, params, id));
    });
  }

  signal(name: string, payload?: any) {
    this.dispatch(makeSignalMessage(name, payload));
  }

  protected _raiseError(code: number, reason?: string, context?: TransportContext): void;
  protected _raiseError(reason: string, code?: number, context?: TransportContext): void;
  protected _raiseError(code: number | string, reason?: number | string, context?: TransportContext): void {
    let codeToUse: number;
    let reasonToUse: string;
    if (typeof code === 'number') {
      codeToUse = code;
      reasonToUse = <string>reason;
    } else {
      codeToUse = <number>reason;
      reasonToUse = code;
    }

    const error = createError(codeToUse || ErrorCodes.INTERNAL_ERROR, reasonToUse);
    this.emit('error', error);


    this.dispatch(makeInternalMessage(
      MSG_ERROR,
      error,
    ), context);
  }

  protected _handleSignal(message: Message, context?: TransportContext): void {
    if (!this._signals.listenerCount('signal') && !this._signals.listenerCount(message.name)) {
      return this._raiseError(`invalid signal ${message.name}`, undefined, context);
    }
    this._signals.emit(message.name, message.payload, context);
  }

  protected _handelRequest(message: Message, context?: TransportContext): any {
    if (!this._methods[message.name]) {
      // return this._raiseError(`invalid method "${message.name}"`);

      return this.dispatch(makeInternalMessage(
        MSG_REJECT,
        createError(ErrorCodes.METHOD_NOT_FOUND, `invalid method "${message.name}"`),
        message.id
      ), context);
    }

    return this.call(message.name, message.payload).then(
      (result: any) => this.dispatch(makeInternalMessage(
        MSG_RESOLVE,
        result,
        message.id
      ), context),
      (reason: any) => this.dispatch(makeInternalMessage(
        MSG_REJECT,
        reason,
        message.id
      ), context)
    );
  }

  protected _handleInternal(message: Message, context?: TransportContext): any {
    switch (message.name) {
      case MSG_RESOLVE:
        if (!message.id && message.id != 0) {
          return this._raiseError(`invalid internal message. message "id" is required`, undefined, context);
        }
        if (!this._txs[message.id]) {
          return this._raiseError(`no pending transaction with id ${message.id}`, undefined, context);
        }

        this._txs[message.id].resolve(message.payload);
        this._clearTransaction(this._txs[message.id]);

        break;

      case MSG_REJECT:
        if (!message.id && message.id != 0) {
          return this._raiseError(`invalid internal message. message "id" is required`, undefined, context);
        }
        if (!this._txs[message.id]) {
          return this._raiseError(`no pending transaction with id ${message.id}`, undefined, context);
        }

        this._txs[message.id].reject(message.payload);
        this._clearTransaction(this._txs[message.id]);

        break;

      case MSG_ERROR:
        this.emit('error', message.payload, undefined, context);
        break;

      default:
        this._raiseError(`unhandled internal message ${message.name}`, undefined, context);
        break;
    }
  }

  protected _handleTimeout(transaction: Transaction): void {
    transaction.reject('transaction timed out');
    this._raiseError(`transaction ${transaction.id} timed out`);
    delete this._txs[transaction.id];
  }

  protected _clearTransaction(transaction: Transaction): void {
    if (typeof(transaction.hTimeout) !== 'undefined') {
      clearTimeout(transaction.hTimeout);
    }

    delete this._txs[transaction.id];
  }

}
