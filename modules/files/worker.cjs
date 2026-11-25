// Runs inside the OS sandbox, so path checks do not have to substitute for OS isolation.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

try {
  const { operation, ...args } = JSON.parse(fs.readFileSync(0, 'utf8'));
  const root = fs.realpathSync(process.cwd());
  const privateName = (name) =>
    [
      '.git',
      '.aws',
      '.ssh',
      '.codex',
      '.claude',
      '.npmrc',
      '.netrc',
      '.git-credentials',
      'id_rsa',
      'id_ed25519',
    ].includes(name) ||
    /^\.env(?:\.|$)/i.test(name) ||
    /\.(pem|key|p12|pfx|keystore)$/i.test(name);
  const inside = (filename) => filename === root || filename.startsWith(root + path.sep);
  const allowed = (filename) => {
    if (!inside(filename) || path.relative(root, filename).split(path.sep).some(privateName))
      throw Error('Path is outside the workspace or contains private metadata.');
  };
  if (typeof args.path !== 'string' || args.path.includes('\0'))
    throw Error('path must be a string without null bytes.');

  const filename = path.resolve(root, args.path);
  allowed(filename);
  let existing = filename;
  while (!fs.existsSync(existing)) {
    if (fs.lstatSync(existing, {
      throwIfNoEntry: false,
    })?.isSymbolicLink())
      throw Error('Path contains a dangling symlink.');

    existing = path.dirname(existing);
  }
  allowed(fs.realpathSync(existing));
  if (operation === 'list') {
    const entries = fs
      .readdirSync(filename, {
        withFileTypes: true,
      })
      .filter((entry) => !privateName(entry.name));
    console.log(
      JSON.stringify(
        entries
          .map((entry) => ({
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file',
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      ),
    );
  } else if (operation === 'read') {
    const text = fs.readFileSync(filename, 'utf8');
    if (text.includes('\0'))
      throw Error('This is a binary file.');

    const lines = text.split('\n');
    const start = args.line ?? 1;
    const count = args.count ?? 200;
    if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(count) || count < 1)
      throw Error('line and count must be positive integers.');

    console.log(
      JSON.stringify({
        path: args.path,
        totalLines: lines.length,
        line: start,
        content: lines
          .slice(start - 1, start - 1 + count)
          .map((text, index) => `${start + index}: ${text}`)
          .join('\n'),
      }),
    );
  } else if (operation === 'write' || operation === 'edit') {
    if (filename === root)
      throw Error('Choose a file inside the workspace.');

    let content = args.content;
    if (operation === 'edit') {
      if (typeof args.find !== 'string' || !args.find.length || typeof args.replace !== 'string')
        throw Error('find must be nonempty text and replace must be text.');

      const current = fs.readFileSync(filename, 'utf8');
      const occurrences = current.split(args.find).length - 1;
      if (!occurrences)
        throw Error('The requested text was not found. Read the current file.');

      if (occurrences !== 1 && args.replaceAll !== true)
        throw Error(
          'The text appears more than once. Include more context or explicitly choose replaceAll.',
        );

      content =
        args.replaceAll === true
          ? current.split(args.find).join(args.replace)
          : current.replace(args.find, () => args.replace);
    }

    if (typeof content !== 'string')
      throw Error('content must be text.');

    const target = fs.existsSync(filename) ? fs.realpathSync(filename) : filename;
    allowed(target);
    fs.mkdirSync(path.dirname(target), {
      recursive: true,
    });
    const temporary = path.join(path.dirname(target), '.buro-write-' + crypto.randomUUID());
    try {
      const mode = fs.statSync(target, {
        throwIfNoEntry: false,
      })?.mode ?? 0o644;
      fs.writeFileSync(temporary, content, {
        flag: 'wx',
        mode,
      });
      fs.renameSync(temporary, target);
    } finally {
      fs.rmSync(temporary, {
        force: true,
      });
    }
    console.log(JSON.stringify({
      path: args.path,
      bytes: Buffer.byteLength(content),
    }));
  } else if (operation === 'delete') {
    if (filename === root)
      throw Error('Choose a path inside the workspace.');

    fs.rmSync(filename, {
      recursive: true,
      force: true,
    });
    console.log('Removed ' + args.path);
  } else
    throw Error('Unknown file operation.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
