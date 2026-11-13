declare module "core-js-pure/actual/structured-clone.js" {
  const cloneStructuredValue: typeof globalThis.structuredClone;
  export default cloneStructuredValue;
}

declare module "core-js-pure/actual/array/virtual/at.js" {
  const arrayAt: typeof Array.prototype.at;
  export default arrayAt;
}

declare module "core-js-pure/actual/object/has-own.js" {
  const objectHasOwn: typeof Object.hasOwn;
  export default objectHasOwn;
}
