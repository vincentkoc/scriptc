function format(value) {
  const error = new Error(value);
  error.span = "context";
  error.stack = "custom stack";
  for (const key of ["span", "stack", "other"]) console.log(key, key in error);
  console.log(error.span, error.stack);
  const key = "extra";
  error[key] = 42;
  console.log(error[key]);
}
format("bad");

// Property descriptors and symbols stay on the Error when temporary views leave scope.
const symbol = Symbol("error property");
const receiverSymbol = Symbol("receiver");
const throwingSymbol = Symbol("throwing getter");
const nativeSymbol = Symbol("native field");
const setterSymbol = Symbol("setter");
const temporarySymbol = Symbol("temporary");
const sentinel = new Error("getter sentinel");
let getterCalls = 0;
let jsonCalls = 0;
/** @type {any} */
let jsonReceiver;
function decorate(error) {
  error[symbol] = 17;
  Object.defineProperty(error, "hidden", { value: 23, configurable: true });
  Object.defineProperty(error, "receiver", { get() { return this; } });
  Object.defineProperty(error, receiverSymbol, { get() { return this; } });
  Object.defineProperty(error, "throwing", {
    enumerable: true,
    get() { getterCalls++; throw sentinel; },
  });
  Object.defineProperty(error, throwingSymbol, {
    get() { getterCalls++; throw sentinel; },
  });
  Object.defineProperty(error, "toJSON", {
    get() { jsonCalls++; jsonReceiver = this; return undefined; },
  });
  error.stack = { saved: true };
  return error;
}
/** @param {any} error */
function checkProperties(error) {
  console.log(error[symbol], error.hidden, error.receiver === error, error.stack.saved);
  console.log("symbol receiver", error[receiverSymbol] === error);
  const inherited = Object.create(error);
  console.log("inherited receivers", inherited.receiver === inherited, inherited[receiverSymbol] === inherited);
  const alternate = {};
  console.log("explicit receivers", Reflect.get(error, "receiver", alternate) === alternate,
    Reflect.get(error, receiverSymbol, alternate) === alternate);
  let before = getterCalls;
  try { error.throwing; } catch (caught) {
    console.log("string throw", caught === sentinel, getterCalls - before);
  }
  before = getterCalls;
  try { error[throwingSymbol]; } catch (caught) {
    console.log("symbol throw", caught === sentinel, getterCalls - before);
  }
  before = getterCalls;
  const beforeJSON = jsonCalls;
  try { JSON.stringify(error); } catch (caught) {
    console.log("JSON throw", caught === sentinel, getterCalls - before);
  }
  console.log("toJSON getter", jsonReceiver === error, jsonCalls - beforeJSON);
  console.log(Object.getOwnPropertyDescriptor(error, "hidden").enumerable);
  delete error.hidden;
  console.log("hidden deleted", !("hidden" in error));
}
// Compiled Error subclasses retain the existing integrity and Reflect deletion fences.
/** @param {any} error */
function checkBuiltinIntegrity(error) {
  error.removable = 31;
  console.log("Reflect delete", Reflect.deleteProperty(error, "removable"), !("removable" in error),
    Reflect.deleteProperty(error, symbol), error[symbol] === undefined,
    Reflect.deleteProperty(error, "receiver"));
  Object.freeze(error);
  console.log(Object.isFrozen(error));
}
const owned = new Error("owned");
decorate(owned);
checkProperties(owned);
checkBuiltinIntegrity(owned);
class PropertyError extends Error {
  [nativeSymbol] = 1;
  count = 0;
  method() { return 5; }
}
const subclass = new PropertyError("subclass");
decorate(subclass);
checkProperties(subclass);

/** @param {any} error */
function readNative(error) { return error[nativeSymbol]; }
/** @param {any} error */
function writeNative(error) { error[nativeSymbol] = 3; error.other = 4; }
console.log("native initial", readNative(subclass));
subclass[nativeSymbol] = 2;
console.log("typed to dynamic", readNative(subclass));
writeNative(subclass);
console.log("dynamic to typed", subclass[nativeSymbol], readNative(subclass));

/** @param {any} error */
function installSetters(error) {
  Object.defineProperty(error, "setter", {
    set(value) { subclass.count = value; console.log("string setter", this === error); },
  });
  Object.defineProperty(error, setterSymbol, {
    set(value) { subclass.count = value; console.log("symbol setter", this === error); },
  });
  Object.defineProperty(error, "method", { get() { return this; } });
}
/** @param {any} error */
function checkSetters(error) {
  error.setter = 6;
  console.log("string setter field", subclass.count);
  error[setterSymbol] = 7;
  console.log("symbol setter field", subclass.count);
  console.log("method shadow", error.method === error);
  error[temporarySymbol] = 8;
  error.other = 9;
  console.log("symbol stored", error[temporarySymbol]);
  delete error[temporarySymbol];
  error.other = 10;
}
/** @param {any} error */
function checkDeleted(error) {
  console.log("symbol deleted", !(temporarySymbol in error), error[temporarySymbol] === undefined);
  console.log("native retained", error[nativeSymbol]);
}
installSetters(subclass);
checkSetters(subclass);
checkDeleted(subclass);

/** @param {any} error */
function deleteStack(error) {
  delete error.stack;
  error.afterDelete = 1;
  console.log("stack absent", error.stack === undefined,
    Object.getOwnPropertyDescriptor(error, "stack") === undefined);
}
/** @param {any} error */
function restoreStack(error) {
  console.log("stack still absent", error.stack === undefined, !("stack" in error));
  error.stack = "restored stack";
  console.log("stack restored", error.stack,
    Object.getOwnPropertyDescriptor(error, "stack").enumerable);
}
const deletedBuiltin = new Error("deleted builtin");
deleteStack(deletedBuiltin);
restoreStack(deletedBuiltin);
const deletedSubclass = new PropertyError("deleted subclass");
deleteStack(deletedSubclass);
restoreStack(deletedSubclass);

/** @param {any} error */
function throwingStackSetter(error) {
  error.stack = "original cache";
  /** @type {any} */
  const nativeGetter = Object.getOwnPropertyDescriptor(error, "stack").get;
  if (typeof nativeGetter !== "function") throw new Error("missing native stack getter");
  Object.defineProperty(error, "stack", {
    get() { return "custom stack"; },
    set(value) { console.log("stack setter receiver", this === error); throw sentinel; },
    configurable: true,
  });
  try { error.stack = "rejected cache"; } catch (caught) {
    console.log("stack setter throw", caught === sentinel);
  }
  console.log("stack setter cache", nativeGetter.call(error), error.stack);
}
throwingStackSetter(new Error("setter builtin"));
throwingStackSetter(new PropertyError("setter subclass"));
