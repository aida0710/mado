import { Pool } from 'pg'

export interface Pools {
  rw: Pool
  ro: Pool
}

export interface PoolConfig {
  rw: string
  ro: string
}

export function createPools(cfg: PoolConfig): Pools {
  return {
    rw: new Pool({ connectionString: cfg.rw, max: 10 }),
    ro: new Pool({ connectionString: cfg.ro, max: 10 }),
  }
}

export async function closePools(p: Pools): Promise<void> {
  await Promise.all([p.rw.end(), p.ro.end()])
}
