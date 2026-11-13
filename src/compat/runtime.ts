import "./structuredClone";
import arrayAt from "core-js-pure/actual/array/virtual/at.js";
import objectHasOwn from "core-js-pure/actual/object/has-own.js";

// Worker realms need the same capability guards as the main page.
if (typeof Array.prototype.at !== "function") {
  Object.defineProperty(Array.prototype, "at", {
    value: arrayAt, configurable: true, writable: true,
  });
}
if (typeof Object.hasOwn !== "function") {
  Object.defineProperty(Object, "hasOwn", {
    value: objectHasOwn, configurable: true, writable: true,
  });
}
