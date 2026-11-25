import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

/** Reads or creates the local UI/CLI credential without publishing it through a network endpoint. */
export const apiCredential = async (input: { directory: string }): Promise<string> => {
  const directory = path.resolve(input.directory, 'private');
  const filename = path.join(directory, 'api-token');
  await fs.mkdir(directory, {
    recursive: true,
    mode: 0o700,
  });
  await fs.chmod(directory, 0o700);
  const temporary = path.join(directory, '.api-token-' + randomUUID());
  try {
    const token = randomBytes(32).toString('hex');
    const file = await fs.open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(token);
      await file.sync();
    } finally {
      await file.close();
    }
    await fs.link(temporary, filename);
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
      throw error;
  } finally {
    await fs.rm(temporary, {
      force: true,
    });
  }
  const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await file.stat()).isFile())
      throw new Error('The local API credential is not a regular file.');

    await file.chmod(0o600);
    const token = (await file.readFile('utf8')).trim();
    if (!/^[a-f0-9]{64}$/.test(token))
      throw new Error('The local API credential is invalid.');

    return token;
  } finally {
    await file.close();
  }
};
