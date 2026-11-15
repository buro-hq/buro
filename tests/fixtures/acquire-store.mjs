import { FileProjectStore } from '../../adapters/files/project-store.ts';
const directory = process.argv[2];
try {
  const store = await FileProjectStore.open({
    directory,
    project: { id: 'sample', name: 'Sample', root: directory },
  });
  console.log('acquired');
  await new Promise((r) => setTimeout(r, 400));
  await store.close();
} catch (e) {
  console.log(e.code || e.message);
}
