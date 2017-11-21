/// <reference types="zen-observable" />
import * as Observable from 'zen-observable';
export default function observableToAsyncIterable(observable: Observable<any>): AsyncIterableIterator<any>;
