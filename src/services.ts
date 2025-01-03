import https from 'node:https'
import * as dynamo from '@aws-sdk/client-dynamodb'
import * as libDynamo from '@aws-sdk/lib-dynamodb'
import { Client as OpenSearchClient } from '@opensearch-project/opensearch'
import { MongoClient } from 'mongodb'
import knex from 'knex'
import { ServicesContext } from '@node-in-layers/core/index.js'
import curry from 'lodash/curry.js'
import omit from 'lodash/omit.js'
import {
  DatastoreProvider,
  orm,
  OrmModel,
  OrmQuery,
} from 'functional-models-orm'
import { datastoreProvider as dynamoDatastoreProvider } from 'functional-models-orm-dynamo'
import { datastoreProvider as opensearchDatastoreProvider } from 'functional-models-orm-elastic'
import { datastoreProvider as mongoDatastoreProvider } from 'functional-models-orm-mongo'
import { datastoreProvider as sqlDatastoreProvider } from 'functional-models-orm-sql'
import * as memoryDatastoreProvider from 'functional-models-orm/datastore/memory.js'
import { FunctionalModel } from 'functional-models/interfaces.js'
import { asyncMap } from 'modern-async'
import {
  DatabaseObjectsProps,
  DynamoDatabaseObjectsProps,
  MongoDatabaseObjects,
  OpensearchDatabaseObjectsProps,
  SqlDatabaseObjectsProps,
  SupportedDatabase,
  NilDbServices,
  SearchResult,
} from './types.js'
import {
  getSystemInfrastructureName,
  defaultGetTableNameForModel,
  getMongoCollectionNameForModel,
} from './libs.js'

const DEFAULT_MONGO_PORT = 27017

const createMongoConnectionString = ({
  host,
  port,
  username,
  password,
}: {
  host: string
  port?: number | string
  password?: string
  username?: string
}) => {
  return `mongodb://${username ? `${username}:${password}@` : ''}${host}:${
    port || DEFAULT_MONGO_PORT
  }`
}

const createMongoDatabaseObjects = async ({
  environment,
  systemName,
  host,
  port,
  username,
  password,
  getTableNameForModel,
}: MongoDatabaseObjects): Promise<DatabaseObjects<{ mongoClient: any }>> => {
  const database = getSystemInfrastructureName({
    environment,
    systemName,
  })
  const connectionString = createMongoConnectionString({
    host,
    port,
    username,
    password,
  })
  const mongoClient = new MongoClient(connectionString)
  await mongoClient.connect()

  const datastoreProvider = mongoDatastoreProvider({
    mongoClient,
    databaseName: database,
    getCollectionNameForModel: curry(
      getTableNameForModel || getMongoCollectionNameForModel
    )(environment, systemName),
  })
  const cleanup = () => {
    return mongoClient.close()
  }
  return {
    mongoClient,
    datastoreProvider,
    cleanup,
  }
}

const createMemoryDatabaseObjects = (): DatabaseObjects => {
  const datastoreProvider = memoryDatastoreProvider.default.default({})
  return {
    cleanup: () => Promise.resolve(),
    datastoreProvider,
  }
}

const createOpensearchDatabaseObjects = ({
  environment,
  systemName,
  username,
  password,
  host,
  getTableNameForModel,
}: OpensearchDatabaseObjectsProps): DatabaseObjects<{
  opensearchClient: any
}> => {
  const node = `https://${username}:${password}@${host}`
  const client = new OpenSearchClient({
    node,
  })
  return {
    cleanup: () => Promise.resolve(),
    opensearchClient: client,
    datastoreProvider: opensearchDatastoreProvider.create({
      client,
      getIndexForModel: curry(
        getTableNameForModel || defaultGetTableNameForModel
      )(environment, systemName),
    }),
  }
}

const createSqlDatabaseObjects = (
  props: SqlDatabaseObjectsProps
): DatabaseObjects<{ knexClient: any }> => {
  const needsDatabase = props.datastoreType !== 'sqlite'
  const knexConfig = {
    client: props.datastoreType,
    ...(needsDatabase
      ? {
          database: getSystemInfrastructureName({
            environment: props.environment,
            systemName: props.systemName,
          }),
        }
      : {}),
    connection: {
      ...omit(props, [
        'datastoreType',
        'environment',
        'systemName',
        'database',
      ]),
    },
  }
  // @ts-ignore
  const knexClient = knex(knexConfig)
  const datastoreProvider = sqlDatastoreProvider({
    knex: knexClient,
    getTableNameForModel: curry(
      props.getTableNameForModel || defaultGetTableNameForModel
    )(props.environment, props.systemName),
    //propertyTypeToParser: sqlParsers.BasicPropertyTypeToParser
  })

  return {
    knexClient,
    cleanup: () => Promise.resolve(),
    datastoreProvider,
  }
}

const createDynamoDatabaseObjects = ({
  awsRegion,
  environment,
  systemName,
  httpsAgentConfig,
  getTableNameForModel,
}: DynamoDatabaseObjectsProps): DatabaseObjects<{
  dynamoLibs: any
  dynamoDbClient: any
}> => {
  const sslAgent = new https.Agent(
    httpsAgentConfig || {
      keepAlive: true,
      maxSockets: 50,
    }
  )

  const awsConfig = {
    region: awsRegion,
    sslAgent,
  }

  const dynamoDbClient = new dynamo.DynamoDBClient(awsConfig)
  const aws3 = {
    ...dynamo,
    ...libDynamo,
  }

  const datastoreProvider = dynamoDatastoreProvider({
    aws3: {
      ...aws3,
      dynamoDbClient,
    },
    getTableNameForModel: curry(
      getTableNameForModel || defaultGetTableNameForModel
    )(environment, systemName),
  })
  return {
    dynamoLibs: aws3,
    dynamoDbClient,
    datastoreProvider,
    cleanup: () => Promise.resolve(),
  }
}

/**
 * Represents a set of database related objects. Both highlevel and low level.
 * These objects can be utilized deep inside a services layer, to access data.
 */
type DatabaseObjects<T extends object = object> = {
  datastoreProvider: DatastoreProvider
  cleanup: () => Promise<void>
} & T

const _supportedToDatastoreProviderFunc: Record<
  SupportedDatabase,
  DatabaseObjects<any>
> = {
  [SupportedDatabase.memory]: createMemoryDatabaseObjects,
  [SupportedDatabase.dynamo]: createDynamoDatabaseObjects,
  [SupportedDatabase.mongo]: createMongoDatabaseObjects,
  [SupportedDatabase.opensearch]: createOpensearchDatabaseObjects,
  [SupportedDatabase.sqlite]: createSqlDatabaseObjects,
  [SupportedDatabase.mysql]: createSqlDatabaseObjects,
  [SupportedDatabase.postgres]: createSqlDatabaseObjects,
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const create = (context: ServicesContext): NilDbServices => {
  const getDatabaseObjects = (
    props: DatabaseObjectsProps
  ): Promise<DatabaseObjects> | DatabaseObjects => {
    return Promise.resolve().then(() => {
      const func = _supportedToDatastoreProviderFunc[props.datastoreType]
      if (!func) {
        throw new Error(`Unhandled type ${props.datastoreType}`)
      }
      return func(props)
    })
  }

  const getOrm = (props: { datastoreProvider: DatastoreProvider }) => {
    const { Model, fetcher } = orm(props)
    return {
      Model,
      fetcher,
    }
  }

  const simpleCrudsService = <T extends FunctionalModel>(
    model: OrmModel<T>
  ) => {
    const update = (data: T): Promise<T> => {
      return model
        .create(data)
        .save()
        .then(instance => {
          if (!instance) {
            throw new Error(`Impossible situation`)
          }
          return instance.toObj() as unknown as T
        })
    }

    const create = update

    const del = async (id: string | number): Promise<void> => {
      const instance = await model.retrieve(id)
      if (!instance) {
        return undefined
      }
      await instance.delete()
      return undefined
    }

    const retrieve = (id: string | number): Promise<T | undefined> => {
      return model.retrieve(id).then(instance => {
        if (!instance) {
          return undefined
        }
        return instance.toObj() as unknown as T
      })
    }

    const search = (ormQuery: OrmQuery): Promise<SearchResult<T>> => {
      return model.search(ormQuery).then(async result => {
        const instances = (await asyncMap(result.instances, i =>
          i.toObj()
        )) as unknown as readonly T[]
        return {
          instances,
          page: result.page,
        }
      })
    }

    return {
      create,
      update,
      delete: del,
      retrieve,
      search,
    }
  }

  return {
    createMemoryDatabaseObjects,
    createDynamoDatabaseObjects,
    createMongoDatabaseObjects,
    createOpensearchDatabaseObjects,
    createSqlDatabaseObjects,
    // This is the default way of getting a datastoreProvider
    getDatabaseObjects,
    getOrm,
    simpleCrudsService,
  }
}

export { create }