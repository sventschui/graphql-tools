"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var Observable = require("zen-observable");
var iterall_1 = require("iterall");
var errors_1 = require("./errors");
var observableToAsyncIterable_1 = require("./observableToAsyncIterable");
var graphql_1 = require("graphql");
function makeSubscriptionDelegate(_a) {
    var link = _a.link;
    return function subscribe(root, args, context, info) {
        var fragments = Object.keys(info.fragments).map(function (fragment) { return info.fragments[fragment]; });
        var document = {
            kind: graphql_1.Kind.DOCUMENT,
            definitions: [info.operation].concat(fragments),
        };
        var observable = Observable.from(link.request({
            query: document,
            variables: info.variableValues,
            operationName: info.operation && info.operation.name && info.operation.name.value,
            extensions: null,
            setContext: function (context) { return context; },
            getContext: function () { return context; },
            toKey: function () { return 'string'; },
        }))
            .map(function (itm) {
            return (_a = {}, _a[info.fieldName] = errors_1.checkResultAndHandleErrors(itm, info), _a);
            var _a;
        });
        observable[iterall_1.$$asyncIterator] = function () { return observableToAsyncIterable_1.default(this); };
        return observable;
    };
}
exports.default = makeSubscriptionDelegate;
//# sourceMappingURL=makeSubscriptionDelegate.js.map