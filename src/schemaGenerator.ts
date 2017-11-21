// Generates a schema for graphql-js given a shorthand schema

// TODO: document each function clearly in the code: what arguments it accepts
// and what it outputs.

// TODO: we should refactor this file, rename it to makeExecutableSchema, and move
// a bunch of utility functions into a separate utitlities folder, one file per function.

import {
  DocumentNode,
  parse,
  print,
  Kind,
  DefinitionNode,
  defaultFieldResolver,
  buildASTSchema,
  extendSchema,
  GraphQLScalarType,
  getNamedType,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLResolveInfo,
  GraphQLField,
  GraphQLFieldResolver,
  GraphQLType,
  GraphQLInterfaceType,
  GraphQLFieldMap,
} from 'graphql';
import {
  IExecutableSchemaDefinition,
  ILogger,
  IResolvers,
  ITypeDefinitions,
  ITypedef,
  IFieldIteratorFn,
  IConnectors,
  IConnector,
  IConnectorCls,
  IResolverValidationOptions,
} from './Interfaces';

import { deprecated } from 'deprecated-decorator';

// @schemaDefinition: A GraphQL type schema in shorthand
// @resolvers: Definitions for resolvers to be merged with schema
class SchemaError extends Error {
  public message: string;

  constructor(message: string) {
    super(message);
    this.message = message;
    Error.captureStackTrace(this, this.constructor);
  }
}

// type definitions can be a string or an array of strings.
function _generateSchema(
  typeDefinitions: ITypeDefinitions,
  resolveFunctions: IResolvers,
  logger: ILogger,
  // TODO: rename to allowUndefinedInResolve to be consistent
  allowUndefinedInResolve: boolean,
  resolverValidationOptions: IResolverValidationOptions,
) {
  if (typeof resolverValidationOptions !== 'object') {
    throw new SchemaError(
      'Expected `resolverValidationOptions` to be an object',
    );
  }
  if (!typeDefinitions) {
    throw new SchemaError('Must provide typeDefs');
  }
  if (!resolveFunctions) {
    throw new SchemaError('Must provide resolvers');
  }

  // TODO: check that typeDefinitions is either string or array of strings

  const schema = buildSchemaFromTypeDefinitions(typeDefinitions);

  addResolveFunctionsToSchema(
    schema,
    resolveFunctions,
    resolverValidationOptions,
  );

  assertResolveFunctionsPresent(schema, resolverValidationOptions);

  if (!allowUndefinedInResolve) {
    addCatchUndefinedToSchema(schema);
  }

  if (logger) {
    addErrorLoggingToSchema(schema, logger);
  }

  return schema;
}

function makeExecutableSchema({
  typeDefs,
  resolvers = {},
  connectors,
  logger,
  allowUndefinedInResolve = true,
  resolverValidationOptions = {},
}: IExecutableSchemaDefinition) {
  const jsSchema = _generateSchema(
    typeDefs,
    resolvers,
    logger,
    allowUndefinedInResolve,
    resolverValidationOptions,
  );
  if (typeof resolvers['__schema'] === 'function') {
    // TODO a bit of a hack now, better rewrite generateSchema to attach it there.
    // not doing that now, because I'd have to rewrite a lot of tests.
    addSchemaLevelResolveFunction(jsSchema, resolvers[
      '__schema'
    ] as GraphQLFieldResolver<any, any>);
  }
  if (connectors) {
    // connectors are optional, at least for now. That means you can just import them in the resolve
    // function if you want.
    attachConnectorsToContext(jsSchema, connectors);
  }
  return jsSchema;
}

function isDocumentNode(
  typeDefinitions: ITypeDefinitions,
): typeDefinitions is DocumentNode {
  return (<DocumentNode>typeDefinitions).kind !== undefined;
}

function uniq(array: Array<any>): Array<any> {
  return array.reduce((accumulator, currentValue) => {
    return accumulator.indexOf(currentValue) === -1
      ? [...accumulator, currentValue]
      : accumulator;
  }, []);
}

function concatenateTypeDefs(
  typeDefinitionsAry: ITypedef[],
  calledFunctionRefs = [] as any,
): string {
  let resolvedTypeDefinitions: string[] = [];
  typeDefinitionsAry.forEach((typeDef: ITypedef) => {
    if (isDocumentNode(typeDef)) {
      typeDef = print(typeDef);
    }

    if (typeof typeDef === 'function') {
      if (calledFunctionRefs.indexOf(typeDef) === -1) {
        calledFunctionRefs.push(typeDef);
        resolvedTypeDefinitions = resolvedTypeDefinitions.concat(
          concatenateTypeDefs(typeDef(), calledFunctionRefs),
        );
      }
    } else if (typeof typeDef === 'string') {
      resolvedTypeDefinitions.push(typeDef.trim());
    } else {
      const type = typeof typeDef;
      throw new SchemaError(
        `typeDef array must contain only strings and functions, got ${type}`,
      );
    }
  });
  return uniq(resolvedTypeDefinitions.map(x => x.trim())).join('\n');
}

function buildSchemaFromTypeDefinitions(
  typeDefinitions: ITypeDefinitions,
): GraphQLSchema {
  // TODO: accept only array here, otherwise interfaces get confusing.
  let myDefinitions = typeDefinitions;
  let astDocument: DocumentNode;

  if (isDocumentNode(typeDefinitions)) {
    astDocument = typeDefinitions;
  } else if (typeof myDefinitions !== 'string') {
    if (!Array.isArray(myDefinitions)) {
      const type = typeof myDefinitions;
      throw new SchemaError(
        `typeDefs must be a string, array or schema AST, got ${type}`,
      );
    }
    myDefinitions = concatenateTypeDefs(myDefinitions);
  }

  if (typeof myDefinitions === 'string') {
    astDocument = parse(myDefinitions);
  }

  let schema: GraphQLSchema = buildASTSchema(astDocument);

  const extensionsAst = extractExtensionDefinitions(astDocument);
  if (extensionsAst.definitions.length > 0) {
    schema = extendSchema(schema, extensionsAst);
  }

  return schema;
}

export function extractExtensionDefinitions(ast: DocumentNode) {
  const extensionDefs = ast.definitions.filter(
    (def: DefinitionNode) => def.kind === Kind.TYPE_EXTENSION_DEFINITION,
  );

  return Object.assign({}, ast, {
    definitions: extensionDefs,
  });
}

function forEachField(schema: GraphQLSchema, fn: IFieldIteratorFn): void {
  const typeMap = schema.getTypeMap();
  Object.keys(typeMap).forEach(typeName => {
    const type = typeMap[typeName];

    // TODO: maybe have an option to include these?
    if (
      !getNamedType(type).name.startsWith('__') &&
      type instanceof GraphQLObjectType
    ) {
      const fields = type.getFields();
      Object.keys(fields).forEach(fieldName => {
        const field = fields[fieldName];
        fn(field, typeName, fieldName);
      });
    }
  });
}

// takes a GraphQL-JS schema and an object of connectors, then attaches
// the connectors to the context by wrapping each query or mutation resolve
// function with a function that attaches connectors if they don't exist.
// attaches connectors only once to make sure they are singletons
const attachConnectorsToContext = deprecated<Function>(
  {
    version: '0.7.0',
    url: 'https://github.com/apollostack/graphql-tools/issues/140',
  },
  function(schema: GraphQLSchema, connectors: IConnectors): void {
    if (!schema || !(schema instanceof GraphQLSchema)) {
      throw new Error(
        'schema must be an instance of GraphQLSchema. ' +
          'This error could be caused by installing more than one version of GraphQL-JS',
      );
    }

    if (typeof connectors !== 'object') {
      const connectorType = typeof connectors;
      throw new Error(
        `Expected connectors to be of type object, got ${connectorType}`,
      );
    }
    if (Object.keys(connectors).length === 0) {
      throw new Error('Expected connectors to not be an empty object');
    }
    if (Array.isArray(connectors)) {
      throw new Error('Expected connectors to be of type object, got Array');
    }
    if (schema['_apolloConnectorsAttached']) {
      throw new Error(
        'Connectors already attached to context, cannot attach more than once',
      );
    }
    schema['_apolloConnectorsAttached'] = true;
    const attachconnectorFn: GraphQLFieldResolver<any, any> = (
      root: any,
      args: { [key: string]: any },
      ctx: any,
    ) => {
      if (typeof ctx !== 'object') {
        // if in any way possible, we should throw an error when the attachconnectors
        // function is called, not when a query is executed.
        const contextType = typeof ctx;
        throw new Error(
          `Cannot attach connector because context is not an object: ${contextType}`,
        );
      }
      if (typeof ctx.connectors === 'undefined') {
        ctx.connectors = {};
      }
      Object.keys(connectors).forEach(connectorName => {
        let connector: IConnector = connectors[connectorName];
        if (!!connector.prototype) {
          ctx.connectors[connectorName] = new (<IConnectorCls>connector)(ctx);
        } else {
          throw new Error(`Connector must be a function or an class`);
        }
      });
      return root;
    };
    addSchemaLevelResolveFunction(schema, attachconnectorFn);
  },
);

// wraps all resolve functions of query, mutation or subscription fields
// with the provided function to simulate a root schema level resolve funciton
function addSchemaLevelResolveFunction(
  schema: GraphQLSchema,
  fn: GraphQLFieldResolver<any, any>,
): void {
  // TODO test that schema is a schema, fn is a function
  const rootTypes = [
    schema.getQueryType(),
    schema.getMutationType(),
    schema.getSubscriptionType(),
  ].filter(x => !!x);
  rootTypes.forEach(type => {
    // XXX this should run at most once per request to simulate a true root resolver
    // for graphql-js this is an approximation that works with queries but not mutations
    const rootResolveFn = runAtMostOncePerRequest(fn);
    const fields = type.getFields();
    Object.keys(fields).forEach(fieldName => {
      // XXX if the type is a subscription, a same query AST will be ran multiple times so we
      // deactivate here the runOnce if it's a subscription. This may not be optimal though...
      if (type === schema.getSubscriptionType()) {
        fields[fieldName].resolve = wrapResolver(fields[fieldName].resolve, fn);
      } else {
        fields[fieldName].resolve = wrapResolver(
          fields[fieldName].resolve,
          rootResolveFn,
        );
      }
    });
  });
}

function getFieldsForType(type: GraphQLType): GraphQLFieldMap<any, any> {
  if (
    type instanceof GraphQLObjectType ||
    type instanceof GraphQLInterfaceType
  ) {
    return type.getFields();
  } else {
    return undefined;
  }
}

function addResolveFunctionsToSchema(
  schema: GraphQLSchema,
  resolveFunctions: IResolvers,
  resolverValidationOptions: IResolverValidationOptions = {},
) {
  const { allowResolversNotInSchema = false } = resolverValidationOptions;

  Object.keys(resolveFunctions).forEach(typeName => {
    const type = schema.getType(typeName);
    if (!type && typeName !== '__schema') {
      if (allowResolversNotInSchema) {
        return;
      }

      throw new SchemaError(
        `"${typeName}" defined in resolvers, but not in schema`,
      );
    }

    Object.keys(resolveFunctions[typeName]).forEach(fieldName => {
      if (fieldName.startsWith('__')) {
        // this is for isTypeOf and resolveType and all the other stuff.
        // TODO require resolveType for unions and interfaces.
        type[fieldName.substring(2)] = resolveFunctions[typeName][fieldName];
        return;
      }

      if (type instanceof GraphQLScalarType) {
        type[fieldName] = resolveFunctions[typeName][fieldName];
        return;
      }

      const fields = getFieldsForType(type);
      if (!fields) {
        if (allowResolversNotInSchema) {
          return;
        }

        throw new SchemaError(
          `${typeName} was defined in resolvers, but it's not an object`,
        );
      }

      if (!fields[fieldName]) {
        if (allowResolversNotInSchema) {
          return;
        }

        throw new SchemaError(
          `${typeName}.${fieldName} defined in resolvers, but not in schema`,
        );
      }
      const field = fields[fieldName];
      const fieldResolve = resolveFunctions[typeName][fieldName];
      if (typeof fieldResolve === 'function') {
        // for convenience. Allows shorter syntax in resolver definition file
        setFieldProperties(field, { resolve: fieldResolve });
      } else {
        if (typeof fieldResolve !== 'object') {
          throw new SchemaError(
            `Resolver ${typeName}.${fieldName} must be object or function`,
          );
        }
        setFieldProperties(field, fieldResolve);
      }
    });
  });
}

function setFieldProperties(
  field: GraphQLField<any, any>,
  propertiesObj: Object,
) {
  Object.keys(propertiesObj).forEach(propertyName => {
    field[propertyName] = propertiesObj[propertyName];
  });
}

function assertResolveFunctionsPresent(
  schema: GraphQLSchema,
  resolverValidationOptions: IResolverValidationOptions = {},
) {
  const {
    requireResolversForArgs = false,
    requireResolversForNonScalar = false,
    requireResolversForAllFields = false,
  } = resolverValidationOptions;

  if (
    requireResolversForAllFields &&
    (requireResolversForArgs || requireResolversForNonScalar)
  ) {
    throw new TypeError(
      'requireResolversForAllFields takes precedence over the more specific assertions. ' +
        'Please configure either requireResolversForAllFields or requireResolversForArgs / ' +
        'requireResolversForNonScalar, but not a combination of them.',
    );
  }

  forEachField(schema, (field, typeName, fieldName) => {
    // requires a resolve function for *every* field.
    if (requireResolversForAllFields) {
      expectResolveFunction(field, typeName, fieldName);
    }

    // requires a resolve function on every field that has arguments
    if (requireResolversForArgs && field.args.length > 0) {
      expectResolveFunction(field, typeName, fieldName);
    }

    // requires a resolve function on every field that returns a non-scalar type
    if (
      requireResolversForNonScalar &&
      !(getNamedType(field.type) instanceof GraphQLScalarType)
    ) {
      expectResolveFunction(field, typeName, fieldName);
    }
  });
}

function expectResolveFunction(
  field: GraphQLField<any, any>,
  typeName: string,
  fieldName: string,
) {
  if (!field.resolve) {
    console.warn(
      // tslint:disable-next-line: max-line-length
      `Resolve function missing for "${typeName}.${fieldName}". To disable this warning check https://github.com/apollostack/graphql-tools/issues/131`,
    );
    return;
  }
  if (typeof field.resolve !== 'function') {
    throw new SchemaError(
      `Resolver "${typeName}.${fieldName}" must be a function`,
    );
  }
}

function addErrorLoggingToSchema(schema: GraphQLSchema, logger: ILogger): void {
  if (!logger) {
    throw new Error('Must provide a logger');
  }
  if (typeof logger.log !== 'function') {
    throw new Error('Logger.log must be a function');
  }
  forEachField(schema, (field, typeName, fieldName) => {
    const errorHint = `${typeName}.${fieldName}`;
    field.resolve = decorateWithLogger(field.resolve, logger, errorHint);
  });
}

// XXX badly named function. this doesn't really wrap, it just chains resolvers...
function wrapResolver(
  innerResolver: GraphQLFieldResolver<any, any> | undefined,
  outerResolver: GraphQLFieldResolver<any, any>,
): GraphQLFieldResolver<any, any> {
  return (obj, args, ctx, info) => {
    return Promise.resolve(outerResolver(obj, args, ctx, info)).then(root => {
      if (innerResolver) {
        return innerResolver(root, args, ctx, info);
      }
      return defaultFieldResolver(root, args, ctx, info);
    });
  };
}

function chainResolvers(resolvers: GraphQLFieldResolver<any, any>[]) {
  return (
    root: any,
    args: { [argName: string]: any },
    ctx: any,
    info: GraphQLResolveInfo,
  ) => {
    return resolvers.reduce((prev, curResolver) => {
      if (curResolver) {
        return curResolver(prev, args, ctx, info);
      }

      return defaultFieldResolver(prev, args, ctx, info);
    }, root);
  };
}

/*
 * fn: The function to decorate with the logger
 * logger: an object instance of type Logger
 * hint: an optional hint to add to the error's message
 */
function decorateWithLogger(
  fn: GraphQLFieldResolver<any, any> | undefined,
  logger: ILogger,
  hint: string,
): GraphQLFieldResolver<any, any> {
  if (typeof fn === 'undefined') {
    fn = defaultFieldResolver;
  }

  const logError = (e: Error) => {
    // TODO: clone the error properly
    const newE = new Error();
    newE.stack = e.stack;
    /* istanbul ignore else: always get the hint from addErrorLoggingToSchema */
    if (hint) {
      newE['originalMessage'] = e.message;
      newE['message'] = `Error in resolver ${hint}\n${e.message}`;
    }
    logger.log(newE);
  };

  return (root, args, ctx, info) => {
    try {
      const result = fn(root, args, ctx, info);
      // If the resolve function returns a Promise log any Promise rejects.
      if (
        result &&
        typeof result.then === 'function' &&
        typeof result.catch === 'function'
      ) {
        result.catch((reason: Error | string) => {
          // make sure that it's an error we're logging.
          const error = reason instanceof Error ? reason : new Error(reason);
          logError(error);

          // We don't want to leave an unhandled exception so pass on error.
          return reason;
        });
      }
      return result;
    } catch (e) {
      logError(e);
      // we want to pass on the error, just in case.
      throw e;
    }
  };
}

function addCatchUndefinedToSchema(schema: GraphQLSchema): void {
  forEachField(schema, (field, typeName, fieldName) => {
    const errorHint = `${typeName}.${fieldName}`;
    field.resolve = decorateToCatchUndefined(field.resolve, errorHint);
  });
}

function decorateToCatchUndefined(
  fn: GraphQLFieldResolver<any, any>,
  hint: string,
): GraphQLFieldResolver<any, any> {
  if (typeof fn === 'undefined') {
    fn = defaultFieldResolver;
  }
  return (root, args, ctx, info) => {
    const result = fn(root, args, ctx, info);
    if (typeof result === 'undefined') {
      throw new Error(`Resolve function for "${hint}" returned undefined`);
    }
    return result;
  };
}

// XXX this function only works for resolvers
// XXX very hacky way to remember if the function
// already ran for this request. This will only work
// if people don't actually cache the operation.
// if they do cache the operation, they will have to
// manually remove the __runAtMostOnce before every request.
function runAtMostOncePerRequest(
  fn: GraphQLFieldResolver<any, any>,
): GraphQLFieldResolver<any, any> {
  let value: any;
  const randomNumber = Math.random();
  return (root, args, ctx, info) => {
    if (!info.operation['__runAtMostOnce']) {
      info.operation['__runAtMostOnce'] = {};
    }
    if (!info.operation['__runAtMostOnce'][randomNumber]) {
      info.operation['__runAtMostOnce'][randomNumber] = true;
      value = fn(root, args, ctx, info);
    }
    return value;
  };
}

export {
  makeExecutableSchema,
  SchemaError,
  forEachField,
  chainResolvers,
  addErrorLoggingToSchema,
  addResolveFunctionsToSchema,
  addCatchUndefinedToSchema,
  assertResolveFunctionsPresent,
  buildSchemaFromTypeDefinitions,
  addSchemaLevelResolveFunction,
  attachConnectorsToContext,
  concatenateTypeDefs,
};
