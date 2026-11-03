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
  console.log(delete error.hidden, "hidden" in error);
  Object.freeze(error);
  console.log(Object.isFrozen(error));
}
const owned = new Error("owned");
decorate(owned);
checkProperties(owned);
class PropertyError extends Error {}
const subclass = new PropertyError("subclass");
decorate(subclass);
checkProperties(subclass);
