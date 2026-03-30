import { resolve, isAbsolute } from 'node:path';

/**
 * Resolve a list path to an absolute directory.
 * Claude passes the path directly — it can be absolute or relative to cwd.
 *
 * @param {string} listPath - Absolute or relative path to the list directory
 * @returns {string} Absolute path
 */
export const resolveListDir = (listPath) => {
  if (!listPath) throw new Error('List path is required.');
  return isAbsolute(listPath) ? listPath : resolve(process.cwd(), listPath);
};
