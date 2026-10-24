export const dirOf = (path) => path.replace(/[\\/][^\\/]*$/, "");
export const baseName = (path) => path.replace(/^.*[\\/]/, "");
