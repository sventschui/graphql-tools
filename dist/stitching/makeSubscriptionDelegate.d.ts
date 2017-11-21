import { ApolloLink } from 'apollo-link';
import { GraphQLFieldResolver } from 'graphql';
export interface MakeSubscriptionDelegateOptions {
    link: ApolloLink;
}
export default function makeSubscriptionDelegate({link}: MakeSubscriptionDelegateOptions): GraphQLFieldResolver<any, any>;
