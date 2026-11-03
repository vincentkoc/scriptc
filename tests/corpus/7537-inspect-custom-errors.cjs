// An Effect-style error class in JavaScript: a method keyed by
// Symbol.for("nodejs.util.inspect.custom") on an Error subclass, called by
// console.log and util.inspect for direct, caught and contained values,
// and the class still constructs and throws when nothing inspects it.
"use strict";
const util = require("util");
const NodeInspectSymbol = Symbol.for("nodejs.util.inspect.custom");
let inspections = 0;

class YieldableError extends Error {
  toJSON() {
    return { _tag: "YieldableError", message: this.message };
  }
  [NodeInspectSymbol]() {
    inspections++;
    return `YieldableError: ${this.message}`;
  }
}

const direct = new YieldableError("direct");
console.log(direct, direct instanceof Error, JSON.stringify(direct));
try {
  throw new YieldableError("boom");
} catch (e) {
  console.log(e instanceof YieldableError, e.message);
  console.log(e);
  console.log(util.inspect([e]), util.inspect({ e }));
}

/** @param {any} value */
function inspectOverrides(value) {
  Object.defineProperty(value, NodeInspectSymbol, {
    value: function() { return `own: ${this.message}`; },
    writable: true,
    configurable: true,
  });
  console.log(util.inspect(value));
  const beforeShadow = inspections;
  Object.defineProperty(value, NodeInspectSymbol, { value: undefined });
  util.inspect(value);
  console.log("own undefined shadows", inspections === beforeShadow);
  delete value[NodeInspectSymbol];
  console.log(util.inspect(value), inspections === beforeShadow + 1);
}
inspectOverrides(direct);
