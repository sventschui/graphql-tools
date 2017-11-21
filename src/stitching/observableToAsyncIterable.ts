import * as Observable from 'zen-observable';

export default async function* observableToAsyncIterable(observable: Observable<any>) {
  function promiseCapability() {
      const x: any = {};
      x.promise = new Promise((a, b) => {
          x.resolve = a;
          x.reject = b;
      });
      return x;
  }

  const observer = {
    _buffer: [promiseCapability()],
    _done: false,

    next(v: any) {
      this._buffer[this._buffer.length - 1].resolve(v);
      this._buffer.push(promiseCapability());
    },

    error(e: any) {
      this._buffer[this._buffer.length - 1].reject(e)
      this._done = true;
    },

    complete(x: any) {
      this._buffer[this._buffer.length - 1].resolve(x)
      this._done = true;
    },
  };

  const subscription = observable.subscribe(observer as any);

  try {
    while (true) {
      let value = await observer._buffer[0].promise;
      observer._buffer.shift()

      if (observer._done) {
        return value;
      }

      yield value;
    }
  } finally {
      subscription.unsubscribe();
  }
}
