/** Reads bytes selected by the user, without exposing a host filesystem path to the server. */
export function uploadedFile(input: { file: File }): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result);
      resolve(value.slice(value.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'));
    reader.readAsDataURL(input.file);
  });
}
