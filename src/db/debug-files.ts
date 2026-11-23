// Assembled source bundles (DESIGN.md §20.4). The bytes are in R2; a row
// says a file with this checksum was assembled for the project.

export type DebugFileRecord = {
  id: number;
  projectId: number;
  checksum: string;
  debugId: string;
  objectName: string;
  arch: string;
  size: number;
  createdAt: number;
};

export type NewDebugFile = Omit<DebugFileRecord, "id">;

const COLUMNS = `rowid AS id, project_id AS projectId, checksum, debug_id AS debugId,
  object_name AS objectName, arch, size, created_at AS createdAt`;

export class DebugFileStore {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  async find(projectId: number, checksum: string): Promise<DebugFileRecord | null> {
    return this.#db
      .prepare(`SELECT ${COLUMNS} FROM debug_files WHERE project_id = ?1 AND checksum = ?2`)
      .bind(projectId, checksum)
      .first<DebugFileRecord>();
  }

  /**
   * Records an assembled file. Two uploads of the same file can race; the
   * second finds the first's row and both answer with it.
   */
  async insert(file: NewDebugFile): Promise<DebugFileRecord> {
    const row = await this.#db
      .prepare(
        `INSERT INTO debug_files
           (project_id, checksum, debug_id, object_name, arch, size, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (project_id, checksum) DO UPDATE SET checksum = excluded.checksum
         RETURNING ${COLUMNS}`,
      )
      .bind(
        file.projectId,
        file.checksum,
        file.debugId,
        file.objectName,
        file.arch,
        file.size,
        file.createdAt,
      )
      .first<DebugFileRecord>();

    if (row === null) {
      throw new Error("debug file insert returned no row");
    }

    return row;
  }
}
