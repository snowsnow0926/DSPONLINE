"use strict";

const { createPackage } = require("@electron/asar");
const { finished } = require("node:stream/promises");

async function createCompletedAsar(source, destination, packageWriter = createPackage) {
  // The pinned ASAR writer resolves to out.end(), not to the stream's finish.
  // Callers must not read, hash, overwrite or remove the archive before this.
  const output = await packageWriter(source, destination);
  await finished(output);
}

module.exports = { createCompletedAsar };
