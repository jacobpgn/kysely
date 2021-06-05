import { Pool, PoolClient } from 'pg'
import { DatabaseConnection, QueryResult } from '../../driver/database-connection'
import { Driver } from '../../driver/driver'
import { CompiledQuery } from '../../query-compiler/compiled-query'
import { freeze } from '../../util/object-utils'

const PRIVATE_RELEASE_METHOD = Symbol()

export class PostgresDriver extends Driver {
  #pool: Pool | null = null
  #connections = new WeakMap<PoolClient, DatabaseConnection>()

  getDefaultPort(): number {
    return 5432
  }

  protected async initImpl(): Promise<void> {
    // Import the `pg` module here instead at the top of the file
    // so that this file can be loaded by node without `pg` driver
    // installed. As you can see, there IS an import from `pg` at the
    // top level too, but that's only for types. It doesn't get compiled
    // into javascript. You can check the built javascript code.
    const pg = await importPg()

    const cfg = this.config
    // Use the `pg` module's own pool. All drivers should use the
    // pool provided by the database library if possible.
    this.#pool = new pg.Pool({
      host: cfg.host,
      database: cfg.database,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,

      // Pool options.
      connectionTimeoutMillis: cfg.pool.connectionTimeoutMillis,
      idleTimeoutMillis: cfg.pool.idleTimeoutMillis,
      max: cfg.pool.maxConnections,
    })
  }

  protected async destroyImpl(): Promise<void> {
    if (this.#pool) {
      const pool = this.#pool
      this.#pool = null
      await pool.end()
    }
  }

  protected async acquireConnectionImpl(): Promise<DatabaseConnection> {
    const client = await this.#pool!.connect()
    let connection = this.#connections.get(client)

    if (!connection) {
      connection = new PostgresConnection(client)
      this.#connections.set(client, connection)

      if (this.config.pool.onCreateConnection) {
        await this.config.pool.onCreateConnection(connection)
      }
    }

    return connection
  }

  protected async releaseConnectionImpl(connection: DatabaseConnection): Promise<void> {
    const pgConnection = connection as PostgresConnection
    pgConnection[PRIVATE_RELEASE_METHOD]()
  }
}

async function importPg() {
  try {
    return import('pg')
  } catch (error) {
    throw new Error(
      'Postgres client not installed. Please run `npm install pg`'
    )
  }
}

class PostgresConnection implements DatabaseConnection {
  #client: PoolClient

  constructor(client: PoolClient) {
    this.#client = client
  }

  async executeQuery<O>(compiledQuery: CompiledQuery): Promise<QueryResult<O>> {
    const result = await this.#client.query<O>(compiledQuery.sql, [
      ...compiledQuery.bindings,
    ])

    return freeze({
      numUpdatedOrDeletedRows:
        result.command === 'UPDATE' || result.command === 'DELETE'
          ? result.rowCount
          : undefined,
      insertedPrimaryKey: undefined,
      rows: result.rows,
    })
  }

  [PRIVATE_RELEASE_METHOD](): void {
    this.#client.release()
  }
}
