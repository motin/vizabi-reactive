import { autorun } from "mobx";
import { fromPromise } from "mobx-utils";

export const createKey2 = (space, row) => space.map(dim => row[dim]).join('-');
// micro-optimizations below as this is code that runs for each row in data to create key to the row

// TODO: probably use different replace function, long version in jsperf
// string replace functions jsperf: https://jsperf.com/string-replace-methods
// regexp not here, not fast in any browser
/**
 * Verbose string replace using progressive indexOf. Fastest in Chrome.
 * Does not manipulate input string.
 * @param {*} str Input string
 * @param {*} ndl Needle to find in input string
 * @param {*} repl Replacement string to replace needle with
 */
function replace(str, ndl, repl) {
    var outstr = '',
        start = 0,
        end = 0,
        l = ndl.length;
    while ((end = str.indexOf(ndl, start)) > -1) {
        outstr += str.slice(start, end) + repl;
        start = end + l;
    }
    return outstr + str.slice(start);
}
// fastest in firefox
function replace_sj(str, ndl, repl) {
    return str.split(ndl).join(repl);
}

// precalc strings for optimization
const escapechar = "\\";
const joinchar = "-";
const dblescape = escapechar + escapechar;
const joinescape = escapechar + joinchar;
var esc = str => isNumeric(str) ? str : replace(replace(str, escapechar, dblescape), joinchar, joinescape);

// jsperf of key-creation options. Simple concat hash + escaping wins: https://jsperf.com/shallow-hash-of-object
// for loop is faster than keys.map().join('-');
// but in Edge, json.stringify is faster
// pre-escaped space would add extra performance
const createDimKeyStr = (dim, dimVal) => {
    if (dimVal instanceof Date) dimVal = dimVal.getTime();
    return esc(dim) + joinchar + esc(dimVal);
}
export const createMarkerKey = (row, space = Object.keys(row).sort()) => {
    const l = space.length;

    if (l===1)
        return row[space[0]]+"";

    var res = (l > 0) ? createDimKeyStr(space[0], row[space[0]]) : '';
    for (var i = 1; i < l; i++) {
        res += joinchar + createDimKeyStr(space[i], row[space[i]]);
    }
    return res
}

export function normalizeKey(key) {
    return key.slice(0).sort();
}

// end micro-optimizations

export const createKeyStr = (key) => key.map(esc).join('-');

export const isNumeric = (n) => !isNaN(n) && isFinite(n);

export function isString(value) {
    return typeof value == 'string';
}

export function isEntityConcept(concept) {
    return ["entity_set", "entity_domain"].includes(concept.concept_type);
}

export function mapToObj(map) {
    const obj = {};
    map.forEach((v, k) => { obj[k] = v });
    return obj;
}

// intersect of two arrays (representing sets)
// i.e. everything in A which is also in B
export function intersect(a, b) {
    return a.filter(e => b.includes(e));
}

/**
 * Is A a proper subset of B
 * Every A is in B, but A != B
 * @param {*} a 
 * @param {*} b 
 */
export function isProperSubset(a, b) {
    const intersection = intersect(a,b);
    return intersection.length == a.length && intersection.length != b.length;
}

/**
 * Relative complement (difference, B\A) of A with respect to B
 * Everything in B which is not in A. A=[geo,year], B=[geo,year,gender], B\A = [gender]
 * @param {*} a array representing set A
 * @param {*} b array representing set B
 */
export function relativeComplement(a, b) {
    return b.filter(e => !a.includes(e));
}

// returns true if a and b are identical, regardless of order (i.e. like sets)
export function arrayEquals(a, b) {
    const overlap = intersect(a, b);
    return overlap.length == a.length && overlap.length == b.length;
}

// copies properties using property descriptors so accessors (and other meta-properties) get correctly copied
// https://www.webreflection.co.uk/blog/2015/10/06/how-to-copy-objects-in-javascript
// rewrote for clarity and make sources overwrite target (mimic Object.assign)
export function assign(target, ...sources) {
    sources.forEach(source => {
        Object.keys(source).forEach(property => {
            Object.defineProperty(target, property, Object.getOwnPropertyDescriptor(source, property));
        });
    });
    return target;
}
export function compose(...parts) {
    return assign({}, ...parts);
}

export function ucFirst(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

// gets a getter accessor from an object and binds it to the object
// used to overload methods when decorating objects
export function getBoundGetter(obj, prop) {
    return Object.getOwnPropertyDescriptor(obj, prop).get.bind(obj);
}

export function moveProperty(oldObj, oldProp, newObj, newProp) {
    Object.defineProperty(newObj, newProp, Object.getOwnPropertyDescriptor(oldObj, oldProp));
}
export function renameProperty(obj, oldProp, newProp) {
    moveProperty(obj, oldProp, obj, newProp)
}

export function fromPromiseAll(promiseArray) {
    if (promiseArray.every(p.state == "fulfilled"))
        return fromPromise.resolve(promiseArray);
    if (promiseArray.some(p => p.state == "rejected"))
        return fromPromise.reject(promiseArray);
}

export function processConfig(config, props) {
    const obj = {};
    props.forEach(p => {
        const prop = (p.fn) ? p.prop : p;
        if (config[prop]) {
            obj[prop] = (p.fn) ? p.fn(config[prop]) : config[prop];
        }
    });
    return obj;
}

export function defaultDecorator({ base, defaultConfig = {}, functions = {} }) {
    if (Array.isArray(functions)) functions = assign({}, ...functions);
    return function decorate(config, parent) {
        applyDefaults(config, defaultConfig);
        delete functions.config;
        base = (base == null) ? (config, parent) => ({ config, parent }) : base;
        return assign(base(config, parent), functions);
    }
}

// code from https://github.com/TehShrike/is-mergeable-object
function isMergeableObject(value) {
    return isNonNullObject(value) &&
        !isSpecial(value)
}

export function isNonNullObject(value) {
    return !!value && typeof value === 'object'
}

function isSpecial(value) {
    var stringValue = Object.prototype.toString.call(value)

    return stringValue === '[object RegExp]' ||
        stringValue === '[object Date]' ||
        isReactElement(value)
}

// see https://github.com/facebook/react/blob/b5ac963fb791d1298e7f396236383bc955f916c1/src/isomorphic/classic/element/ReactElement.js#L21-L25
var canUseSymbol = typeof Symbol === 'function' && Symbol.for
var REACT_ELEMENT_TYPE = canUseSymbol ? Symbol.for('react.element') : 0xeac7

function isReactElement(value) {
    return value.$$typeof === REACT_ELEMENT_TYPE
}

// c merge and helpers
// code from https://github.com/KyleAMathews/deepmerge
function emptyTarget(val) {
    return Array.isArray(val) ? [] : {}
}

function cloneUnlessOtherwiseSpecified(value, options) {
    return (options.clone !== false && options.isMergeableObject(value)) ?
        deepmerge(emptyTarget(value), value, options) :
        value
}

function defaultArrayMerge(target, source, options) {
    return target.concat(source).map(function(element) {
        return cloneUnlessOtherwiseSpecified(element, options)
    })
}

function mergeObject(target, source, options) {
    var destination = {}
    if (options.isMergeableObject(target)) {
        Object.keys(target).forEach(function(key) {
            destination[key] = cloneUnlessOtherwiseSpecified(target[key], options)
        })
    }
    Object.keys(source).forEach(function(key) {
        if (!options.isMergeableObject(source[key]) || !target[key]) {
            destination[key] = cloneUnlessOtherwiseSpecified(source[key], options)
        } else {
            destination[key] = deepmerge(target[key], source[key], options)
        }
    })
    return destination
}

const overwriteMerge = (destinationArray, sourceArray, options) => sourceArray

export function deepmerge(target, source, options) {
    options = options || {}
    options.arrayMerge = options.arrayMerge || overwriteMerge
    options.isMergeableObject = options.isMergeableObject || isMergeableObject

    var sourceIsArray = Array.isArray(source)
    var targetIsArray = Array.isArray(target)
    var sourceAndTargetTypesMatch = sourceIsArray === targetIsArray

    if (!sourceAndTargetTypesMatch) {
        return cloneUnlessOtherwiseSpecified(source, options)
    } else if (sourceIsArray) {
        return options.arrayMerge(target, source, options)
    } else {
        return mergeObject(target, source, options)
    }
}

deepmerge.all = function deepmergeAll(array, options) {
    if (!Array.isArray(array)) {
        throw new Error('first argument should be an array')
    }

    return array.reduce(function(prev, next) {
        return deepmerge(prev, next, options)
    }, {})
}

export function deepclone(object) {
    return deepmerge({}, object);
}

export function applyDefaults(config, defaults) {
    const defaultProps = Object.keys(defaults);
    defaultProps.forEach(prop => {
        if (!config.hasOwnProperty(prop))
            if (isMergeableObject(defaults[prop]))
                config[prop] = deepclone(defaults[prop]); // object
            else
                config[prop] = defaults[prop]; // non object, e.g. null
        else if (isMergeableObject(defaults[prop]))
            if (isMergeableObject(config[prop]))
                applyDefaults(config[prop], defaults[prop]);
            else
                config[prop] = deepclone(defaults[prop]);
    })
}

export function equals(a,b) {
    if (a instanceof Date && b instanceof Date) {
        return a.getTime() === b.getTime();
    }
    return a === b;
}


export function getTimeInterval(unit) {
    let interval;
    if (interval = d3['utc' + ucFirst(unit)]) return interval;
}

export function configValue(value, concept) {
    const { concept_type } = concept;
    if (concept_type == "time" && value instanceof Date) {
        return concept.format ? d3.utcFormat(concept.format)(value) : formatDate(value);
    }
    return value;
}

const defaultParsers = [
    d3.utcParse('%Y'),
    d3.utcParse('%Y-%m'),
    d3.utcParse('%Y-%m-%d'),
    d3.utcParse('%Y-%m-%dT%H'),
    d3.utcParse('%Y-%m-%dT%H-%M'),
    d3.utcParse('%Y-%m-%dT%H-%M-%S')
];

function tryParse(timeString, parsers) {
    for (let i = 0; i < parsers.length; i++) {
      let dateObject = parsers[i](timeString);
      if (dateObject) return dateObject;
    }
    console.warn('Could not parse time string ' + timeString)
    return null;
}

export function parseConfigValue(valueStr, concept) {
    const { concept_type } = concept;

    if (concept_type === "time") {
        let parsers = concept.format 
            ? [d3.utcParse(concept.format), ...defaultParsers]
            : defaultParsers;
        return tryParse(valueStr, parsers);
    }

    if (concept_type === "measure") {
        return +valueStr;
    }

    return ""+valueStr;
}

function pad(value, width) {
    var s = value + "", length = s.length;
    return length < width ? new Array(width - length + 1).join(0) + s : s;
}
  
function formatYear(year) {
    return year < 0 ? "-" + pad(-year, 6)
        : year > 9999 ? "+" + pad(year, 6)
        : pad(year, 4);
}
  
function formatDate(date) {
    var month = date.getUTCMonth(),
        day = date.getUTCDate(),
        hours = date.getUTCHours(),
        minutes = date.getUTCMinutes(),
        seconds = date.getUTCSeconds(),
        milliseconds = date.getUTCMilliseconds();
    return isNaN(date) ? "Invalid Date"
        : milliseconds ? formatFullDate(date) + "T" + pad(hours, 2) + ":" + pad(minutes, 2) + ":" + pad(seconds, 2) + "." + pad(milliseconds, 3) + "Z"
        : seconds ? formatFullDate(date) + "T" + pad(hours, 2) + ":" + pad(minutes, 2) + ":" + pad(seconds, 2) + "Z"
        : minutes || hours ? formatFullDate(date) + "T" + pad(hours, 2) + ":" + pad(minutes, 2) + "Z"
        : day !== 1 ? formatFullDate(date)
        : month ? formatYear(date.getUTCFullYear(), 4) + "-" + pad(date.getUTCMonth() + 1, 2)
        : formatYear(date.getUTCFullYear(), 4);
  }

  function formatFullDate(date) {
      return formatYear(date.getUTCFullYear(), 4) + "-" + pad(date.getUTCMonth() + 1, 2) + "-" + pad(date.getUTCDate(), 2);
  }