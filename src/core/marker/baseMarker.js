import { trace, reaction, computed, observable, isComputed, isBoxedObservable } from 'mobx';
import { encodingStore } from '../encoding/encodingStore'
import { dataSourceStore } from '../dataSource/dataSourceStore'
import { dataConfigStore } from '../dataConfig/dataConfigStore'
import { assign, applyDefaults, isProperSubset, combineStates } from "../utils";
import { createMarkerKey } from '../../dataframe/utils';
import { configurable } from '../configurable';
import { fullJoin } from '../../dataframe/transforms/fulljoin';
import { DataFrame } from '../../dataframe/dataFrame';
import {fromPromise} from "mobx-utils";

let dataMapCacheExternallyHydrated = null;
let dataExternallyHydrated = null;

const defaultConfig = {
    data: {
        space: [],
        filter: {}
    },
    encoding: {},
};

const defaults = {
    requiredEncodings: [],
    transformations: [
        "frame.frameMap",
        "filterRequired", // after framemap so doesn't remove interpolatable rows
        "trail.addPreviousTrailHeads", // before ordering so trailheads get ordered
        "order.order", 
        "trail.addTrails", // after ordering so trails stay together
        "frame.currentFrame" // final to make it quick
    ]
}

let functions = {
    on: function(prop, fn) {
        if (this.validProp(prop) && typeof fn == "function") {
            const disposer = reaction(
                () => this[prop], 
                propVal => fn.call(this, propVal)
            );
            this.getEventListenersMapFor(prop).set(fn, disposer);
        }
        return this;
    },
    off: function(prop, fn) {
        if (this.validProp(prop) && this.eventListeners.get(prop).has(fn)){
            this.getEventListenersMapFor(prop).get(fn)(); // dispose
            this.getEventListenersMapFor(prop).delete(fn); // delete
        }
        return this;
    },
    validProp(prop) {
        return prop in this;
    },
    get eventListeners() {
        return new Map();
    },
    getEventListenersMapFor(prop) {
        if (!this.eventListeners.has(prop))
            this.eventListeners.set(prop, new Map());
        return this.eventListeners.get(prop);
    },
    get data() {
        if (this.useExternallyHydratedValues) {
            return dataExternallyHydrated;
        }
        return dataConfigStore.getByDefinition(this.config.data, this)
    },
    get requiredEncodings() { return this.config.requiredEncodings || defaults.requiredEncodings },
    get encoding() {
        trace();
        if (Object.keys(this.config.encoding).length > 0)
            return encodingStore.getByDefinitions(this.config.encoding, this);
        
        // get default encodings for data's data source
        let defaultEnc;
        if (defaultEnc = this.data.source.defaultEncoding)
            return encodingStore.getByDefinitions(defaultEnc, this);

        console.warn("No encoding found and marker data source has no default encodings");
    },
    // TODO: encodings should know the property they encode to themselves; not sure how to pass generically yet 
    getEncodingName(encoding) {
        for (let [name, enc] of this.encoding) {
            if (enc == encoding) return name;
        }
    },
    get state() {
        // temporary switches to switch on and off use of ext/int hydrated states during exploration
        const useExt = false;
        const useInt = true;
        if (useExt) {
            console.log("state this.stateExternallyHydratedPromise", this.stateExternallyHydratedPromise);
            if (this.stateExternallyHydratedPromise.state === "fulfilled") {
                return "fulfilled";
            }
        }
        if (useInt) {
            console.log("state this.stateInternallyHydrated", this.stateInternallyHydrated);
            if (this.stateInternallyHydrated === "fulfilled") {
                return "fulfilled";
            }
        }
        return "pending";
    },
    get stateExternallyHydratedPromise() {
        return fromPromise(new Promise((resolve) => {
            // TODO: make the filename include relevant identifiers so that the marker can request the correct file
            fetch('http://localhost:4200/tools/assets/markerState.json.gz')
              .then(response => {
                  console.log("Externally fetched markerState initial stream available")
                  return response.arrayBuffer();
              })
              .then(gzippedMarkerState => {
                  console.log("Externally fetched state fetched and stored in arrayBuffer")
                  // note that a proper server setup would have the response gunzipped already by the browser
                  // as part of using accept-encoding http header, so this gunzipping is not necessary to do in JS
                  const markerStateJson = pako.inflate(gzippedMarkerState, {to: 'string'});
                  console.log("Externally fetched state gunzipped");
                  const markerState = JSON.parse(markerStateJson);
                  console.log("Externally fetched state parsed");
                  const dataMap = DataFrame(markerState.dfArray, markerState.data.space);
                  console.log("Externally fetched state dataMap DataFrame created");
                  dataMapCacheExternallyHydrated = dataMap;
                  dataExternallyHydrated = markerState.data;
                  dataExternallyHydrated.source = markerState.data.source;
                  dataExternallyHydrated.configSolution = markerState.data.configSolution;
                  // dataExternallyHydrated.concept = markerState.data.concept;
                  this.useExternallyHydratedValues = true;
                  console.log("Externally fetched dataMap resolving state as fulfilled");
                  resolve();
              });
        }));
    },
    get stateInternallyHydrated() {
        trace();
        const encodingStates= [...this.encoding.values()].map(enc => enc.data.state);
        const states = [this.data.source.state, ...encodingStates];
        return combineStates(states);
    },
    get availability() {
        const items = [];
        dataSourceStore.getAll().forEach(ds => {
            ds.availability.data.forEach(kv => {
                items.push({ key: kv.key, value: ds.getConcept(kv.value), source: ds });
            })
        })
        return items;
    },
    get spaceAvailability() {
        const items = [];
        dataSourceStore.getAll().forEach(ds => {
            ds.availability.keyLookup.forEach((val, key) => {
                items.push(val);
            })
        })
        return items;
    },
    // computed to cache calculation
    useExternallyHydratedValues: false,
    get dataMapCache() {
        trace();

        if (this.useExternallyHydratedValues) {
            return dataMapCacheExternallyHydrated;
        }

        // prevent recalculating on each encoding data coming in
        if (this.state !== "fulfilled") 
            return DataFrame([], this.data.space);

        const now = Date.now();
        console.log(`get dataMapCache start (with this.state fulfilled)`);
        // console.profile();

        const markerDefiningEncodings = [];
        const markerAmmendingEncodings = [];
        const spaceEncodings = [];
        const constantEncodings = [];

        // sort visual encodings by how they add data to markers
        for (let [name, encoding] of this.encoding) {

            // no data or constant, no further processing (e.g. selections)
            if (encoding.data.concept === undefined && !encoding.data.isConstant())
                continue;

            // constants value (ignores other config like concept etc)
            else if (encoding.data.isConstant())
                constantEncodings.push({ name, encoding });

            // copy data from space/key
            else if (encoding.data.conceptInSpace)
                spaceEncodings.push({ name, encoding });
            
            // own data, not defining final markers (not required or proper subspace)
            else if (isProperSubset(encoding.data.space, this.data.space) || !this.isRequired(name))
                markerAmmendingEncodings.push(this.joinConfig(encoding, name));

            // own data, superspace (includes identical space) and required defining markers
            else
                markerDefiningEncodings.push(this.joinConfig(encoding, name));    

        }
        console.log(`get dataMapCache checkpoint A took ${Date.now() - now}ms`, {markerDefiningEncodings, markerAmmendingEncodings, spaceEncodings, constantEncodings});

        const space = this.data.space;
        // define markers (full join encoding data)
        console.log(`get dataMapCache checkpoint B1 took ${Date.now() - now}ms`);
        let dataMap = fullJoin(markerDefiningEncodings, space);
        console.log(`get dataMapCache checkpoint B2 took ${Date.now() - now}ms`);
        // ammend markers with non-defining data, constants and copies of space
        dataMap = dataMap.leftJoin(markerAmmendingEncodings);
        console.log(`get dataMapCache checkpoint C took ${Date.now() - now}ms`);
        constantEncodings.forEach(({name, encoding}) => {
            dataMap = dataMap.addColumn(name, encoding.data.constant);
        })
        console.log(`get dataMapCache checkpoint D took ${Date.now() - now}ms`);
        spaceEncodings.forEach(({name, encoding}) => {
            const concept = encoding.data.concept;
            dataMap = dataMap.addColumn(name, row => row[concept]);
        });

        // console.profileEnd();
        console.log(`get dataMapCache took ${Date.now() - now}ms - dataMap size: ${dataMap.size}. this.encoding:`, this.encoding, {dataMap}, this, this.data.configSolution);
        // copy this console output variable/object and paste into ../tools-page/src/assets/markerState.json, then gzip it
        const markerState = {dfArray: dataMap.toJSON(), data: this.data, source: this.data.source, configSolution: this.data.configSolution /*, concept: this.data.concept */};
        console.log(JSON.stringify(markerState, null, 2));
        return dataMap;
    },
    joinConfig(encoding, name) {
        return { 
            projection: { 
                [encoding.data.concept]: name
            },
            dataFrame: encoding.data.responseMap
        }
    },
    isRequired(name) {
        return this.requiredEncodings.length === 0 || this.requiredEncodings.includes(name)
    },
    filterRequired(data) {
        const required = this.requiredEncodings;
        return data
            .filter(row => required.every(encName => row.hasOwnProperty(encName) && row[encName] !== null))
            .filterGroups(group => group.size > 0);
    },
    differentiate(xField, data) {
        const frame = this.encoding.get("frame")
        return frame && this.encoding.get(xField) ? frame.differentiate(data, xField) : data
    },
    /**
     * transformationFns is an object 
     *  whose keys are transformation strings
     *  whose values are transformation functions
     */
    get transformationFns() {
        // marker transformation
        const transformations = {
            "filterRequired": this.filterRequired.bind(this)
        };
        // encoding transformations
        for (let [name, enc] of this.encoding) {
            if (enc.transformationFns)
                for (let [tName, t] of Object.entries(enc.transformationFns))
                    transformations[name + '.' + tName] = t;
            if (enc.config && enc.config.data && enc.config.data.transformations instanceof Array) {
                for (let tName of enc.config.data.transformations) {
                    const fn = this[tName];
                    if (fn)
                        transformations[name + '.' + tName] = fn.bind(this, name)
                }
            }
        }
        return transformations;
    },
    /**
     * Transformations is an array of strings, referring to transformations defined on the marker or encodings
     * The array defines the order in which data will be transformed before being served.
     * If a function reference cannot be resolved, it will be skipped. No error will be thrown.
     * Encoding transformations are formatted "<encodingName>.<functionName>". E.g. "frame.currentFrame"
     * Marker transformations are formatted "<functionName>". E.g. "filterRequired"
     * This array of strings enables configuration of transformation order in a serializable format.
     */
    get transformations() {
        const transformations = this.config.transformations || defaults.transformations;
        const transformationFns = this.transformationFns;
        return transformations
            .filter(tStr => tStr in transformationFns)
            .map(tStr => ({
                    fn: this.transformationFns[tStr],
                    name: tStr
            }));
    },
    /**
     * transformedDataMaps is a ES6 Map
     *  whose keys are transformation strings or "final" and
     *  whose values are DataFrames wrapped in a boxed mobx computed. 
     *      The DataFrame is a result of the transformation function applied to the previous DataFrame.  
     */
    // currently all transformation steps are cached in computed values. Computeds are great to prevent recalculations
    // of previous steps when config of one step changes. However, it uses memory. We might want this more configurable.
    get transformedDataMaps() {
        trace();
        const now = Date.now();
        console.log(`get transformedDataMaps start`);
        // returns boxed computed, whose value can be reached by .get()
        // if we'd call .get() in here (returning the value), each change would lead to applying all transformations
        // because transformedDataMaps() would be observering all stepResults
        // would be nice to find a way for transformedDataMaps to just return the value instead of a boxed computed
        const results = new Map();
        let stepResult = observable.box(this.dataMapCache, { deep: false });
        const now2 = Date.now();
        console.log(`get transformedDataMaps after dataMapCache is available took ${Date.now() - now}ms`);
        this.transformations.forEach(({name, fn}) => {
            let prevResult = stepResult; // local reference for closure of computed
            stepResult = computed(
                () => fn(prevResult.get()), 
                { name }
            );
            results.set(name, stepResult);
        });
        results.set('final', stepResult);
        console.log(`get transformedDataMaps took ${Date.now() - now}ms (of which ${Date.now() - now2}ms after dataMapCache was available) - this.dataMapCache size: ${this.dataMapCache.size}. this.transformations:`, this.transformations);
        return results;
    },
    /**
     * Helper function to get values from transformedDataMaps. Used to prevent the awkward `.get(name).get()` syntax.
     */
    getTransformedDataMap(name) {
        if (this.transformedDataMaps.has(name))
            return this.transformedDataMaps.get(name).get();
        console.warn("Requesting unknown transformed data name: ", name);
    },
    get dataMap() {
        return this.transformedDataMaps.get('final').get();
    },
    get dataArray() {
        return this.dataMap.toJSON();
    },
    getDataMapByFrameValue(value) {
        const frame = this.encoding.get("frame");
        if (!frame) return this.dataMap;

        const frameKey = createMarkerKey({ [frame.name]: value }, [frame.name]);
        const data = this.getTransformedDataMap('filterRequired');
        return data.has(frameKey) ? 
            data.get(frameKey)
            :
            getInterpolatedFrame(frame, data, value);

        function getInterpolatedFrame(frame, data, value) {
            const step = frame.stepScale.invert(value);
            const stepsAround = [Math.floor(step), Math.ceil(step)];
            return frame.getInterpolatedFrame(data, step, stepsAround);
        }
    }
}

export function baseMarker(config) {
    applyDefaults(config, defaultConfig);
    return assign({}, functions, configurable, { config });
}