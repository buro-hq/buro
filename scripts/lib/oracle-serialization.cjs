// Evaluated in the confined child before candidate imports. Never call candidate
// toJSON hooks while producing the verification envelope or comparing inputs.
const SAFE_JSON_SOURCE = `
const primitiveJSON = JSON.stringify.bind(JSON);
const arrayMap = Function.call.bind(Array.prototype.map);
const arrayJoin = Function.call.bind(Array.prototype.join);
const ownKeys = Object.keys;
const arrayCheck = Array.isArray;
const finiteNumber = Number.isFinite;
const stringify = value => {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return primitiveJSON(value);
  if (typeof value === 'number' && finiteNumber(value)) return primitiveJSON(value);
  if (arrayCheck(value)) return '[' + arrayJoin(arrayMap(value, stringify), ',') + ']';
  if (typeof value === 'object') return '{' + arrayJoin(arrayMap(ownKeys(value), key => primitiveJSON(key) + ':' + stringify(value[key])), ',') + '}';
  throw Error('Unsupported oracle value');
};
`;
module.exports = { SAFE_JSON_SOURCE };
