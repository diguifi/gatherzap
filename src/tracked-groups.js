import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { failure } from './whatsapp-sync.js';

export function validateGroupIds(ids) {
  if (!Array.isArray(ids) || ids.length > 5000 || ids.some(id => typeof id !== 'string' || !/^\d+(?:-\d+)?@g\.us$/.test(id))) throw failure('invalid_selection');
  return [...new Set(ids)].sort();
}

export async function openTrackedGroups({ filePath } = {}) {
  let groupIds;
  try { groupIds = validateGroupIds(JSON.parse(await readFile(filePath, 'utf8')).groupIds); }
  catch (error) {
    if (error.code !== 'ENOENT') throw failure('selection_store_failed');
    groupIds = [];
    await save(groupIds);
  }
  async function save(ids) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(`${filePath}.tmp`, `${JSON.stringify({ groupIds: ids }, null, 2)}\n`, { mode: 0o600 });
    await rename(`${filePath}.tmp`, filePath);
  }
  let queue = Promise.resolve();
  return {
    getIds: () => [...groupIds],
    setIds(ids) {
      const task = queue.then(async () => {
        const next = validateGroupIds(ids);
        await save(next);
        groupIds = next;
      });
      queue = task.catch(() => {});
      return task;
    },
  };
}
