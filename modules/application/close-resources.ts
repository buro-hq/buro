/** Runs every cleanup step in ownership order, preserving failures after resources are released. */
export const closeResources = async (input: {
  steps: (() => void | Promise<void>)[];
}): Promise<void> => {
  const errors: unknown[] = [];
  for (const close of input.steps) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, 'Application cleanup failed.');
};
