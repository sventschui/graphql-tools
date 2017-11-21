import { ApolloLink } from 'apollo-link';
import * as Observable from 'zen-observable';
import { $$asyncIterator } from 'iterall';
import { checkResultAndHandleErrors } from './errors';
import observableToAsyncIterable from './observableToAsyncIterable';
import { Kind, GraphQLFieldResolver } from 'graphql';

export interface MakeSubscriptionDelegateOptions {
  link: ApolloLink,
}

export default function makeSubscriptionDelegate({ link }: MakeSubscriptionDelegateOptions): GraphQLFieldResolver<any, any> {
  return function subscribe(root, args, context, info): Observable<any> {
    const fragments = Object.keys(info.fragments).map(
      fragment => info.fragments[fragment],
    );
    const document = {
      kind: Kind.DOCUMENT,
      definitions: [info.operation, ...fragments],
    };
    const observable = Observable.from(link.request({
      query: document,
      variables: info.variableValues,
      operationName: info.operation && info.operation.name && info.operation.name.value,
      extensions: null,
      setContext: (context: Record<string, any>): Record<string, any> => { return context; },
      getContext: (): Record<string, any> => { return context },
      toKey: () => 'string',
    }))
      .map(itm => ({ [info.fieldName]: checkResultAndHandleErrors(itm, info) }));

    observable[$$asyncIterator] = function() { return observableToAsyncIterable(this); };

    return observable;
  };
}
