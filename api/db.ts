import { Pool } from 'pg'

export interface Pools {
  rw: Pool
  ro: Pool
}

export interface PoolConfig {
  rw: string
  ro: string
}

export function createPools(config: PoolConfig): Pools {
  return {
    rw: new Pool({ connectionString: config.rw, max: 10 }),
    ro: new Pool({ connectionString: config.ro, max: 10 }),
  }
}

export async function closePools(p: Pools): Promise<void> {
  await Promise.all([p.rw.end(), p.ro.end()])
}
