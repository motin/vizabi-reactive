import { resolveRef } from "../vizabi";
import { dataSourceStore } from "../dataSource/dataSourceStore";
import { trace, observable } from "mobx";
import { applyDefaults, intersect, isNumeric } from "../utils";
import { filter } from "../filter";
import { DataFrame } from "../../dataframe/dataFrame";
import { createFilterFn } from "../../dataframe/transforms/filter";
import { fromPromise, FULFILLED } from "mobx-utils";
import { extent } from "../../dataframe/info/extent";
import { unique } from "../../dataframe/info/unique";
import { createKeyStr, isDataFrame } from "../../dataframe/utils";

const defaultConfig = {
}

const defaults = {
    filter: null,
    constant: null,
    concept: undefined,
    space: null,
    value: null,
    locale: null,
    source: null,
    domain: [0, 1],
    domainDataSource: 'auto'
}

export function dataConfig(config = {}, parent) {

    applyDefaults(config, defaultConfig);
    let latestResponse = [];

    return {
        config,
        parent,
        get invariants() {
            let fails = [];
            if (this.constant && (this.concept || this.source)) fails.push("Can't have constant value and concept or source set.");
            if (this.conceptInSpace && this.source) fails.push("Can't have concept in space and have a source simultaneously");
            if (fails.length > 0)
                console.warn("One or more invariants not satisfied:",fails,this);
        },
        get source() {
            trace();
            if (this.config.source)
                return dataSourceStore.getByDefinition(this.config.source)
            else
                return (this.parent.marker) ? this.parent.marker.data.source : null;
        },
        get space() {
            //trace();
            if(!this.parent.marker) // only markers do space autoconfig
                return this.configSolution.space;
            return this.config.space || (this.parent.marker ? this.parent.marker.data.space : defaults.space)
        },
        get constant() {
            return resolveRef(this.config.constant) || defaults.constant;
        },
        isConstant() {
            return this.constant != null;
        },
        get commonSpace() {
            return intersect(this.space, this.parent.marker.data.space);
        },
        get filter() {
            const config = this.config.filter || (this.parent.marker ? this.parent.marker.data.config.filter : {})
            return observable(filter(config, this));
        },
        get locale() {
            if (this.config.locale)
                return typeof this.config.locale == "string" ? this.config.locale : this.config.locale.id;
            else
                return (this.parent.marker) ? this.parent.marker.data.locale : null;          
        },
        /**
         * TODO: Should be parentConcept
         * @returns {*}
         */
        get concept() { 
            return (this.parent.marker.data.configSolution.encodings || {})[this.parent.name];
            // return this.config.concept ? resolveRef(this.config.concept) : defaults.concept; 
        },
        get conceptProps() { return this.concept && this.source.getConcept(this.concept) },
        get availability() { return this.source.availability.data.map(kv => this.source.getConcept(kv.value)) },
        get domainDataSource() {
            let source = this.config.domainDataSource || defaults.domainDataSource;
            if (source === 'auto') {
                source = this.conceptInSpace
                    ? 'filterRequired'
                    : 'self';
            }
            return source;
        },
        get domainData() {
            const now = Date.now();
            console.log(`get domainData start`);
            const source = this.domainDataSource;
            console.log(`get domainData until after this.domainDataSource took ${Date.now() - now}ms`);

            let data;
            if (source === 'self') {
                data = this.responseMap;
                console.log(`get domainData until after this.responseMap took ${Date.now() - now}ms`);
            } else {
                if (this.parent.marker.transformedDataMaps.has(source)) {
                    console.log(`get domainData until after this.parent.marker.transformedDataMaps.has(source) took ${Date.now() - now}ms`);
                    data = this.parent.marker.transformedDataMaps.get(source).get();
                    console.log(`get domainData until after this.parent.marker.transformedDataMaps.get(source).get() took ${Date.now() - now}ms`);
                } else {
                    if (source === 'markers') {
                        data = this.parent.marker.dataMap;
                        console.log(`get domainData until after this.parent.marker.dataMap took ${Date.now() - now}ms`);
                    } else {
                        data = this.responseMap;
                    }
                }
            }

            console.log(`get domainData took ${Date.now() - now}ms - data size: ${data.size}`);
            return data;
        },
        get domain() {
            trace();
            if (this.isConstant())
                return isNumeric(this.constant) ? [this.constant, this.constant] : [this.constant];

            return this.calcDomain(this.domainData, this.conceptProps);
        },
        calcDomain(data, { concept, concept_type }) {
            const now = Date.now();
            console.log(`get calcDomain start`);
            // use rows api implemented by both group and df
            if (["measure","time"].includes(concept_type)) {
                const r = extent(data.rows(), concept);
                console.log(`get calcDomain took ${Date.now() - now}ms - data size: ${data.size}`);
                return r;
            }

            else {
                const r = unique(data.rows(), concept);
                console.log(`get calcDomain took ${Date.now() - now}ms - data size: ${data.size}`);
                return r;
            }
        },


        /**
         * Finds a config which satisfies both marker.space and encoding.concept autoconfigs
         */
        get configSolution() {
            let encodings;
            let space = resolveRef(this.config.space);
        
            if (space && space.autoconfig) {
                const availableSpaces = [...this.source.availability.keyLookup.values()];
                const satisfiesSpaceAutoCfg = createFilterFn(this.config.space.autoconfig);

                space = availableSpaces
                    .sort((a, b) => a.length - b.length) // smallest spaces first
                    .filter(space => !space.includes("concept") && space
                            .map(c => this.source.getConcept(c))
                            .every(satisfiesSpaceAutoCfg)
                    )
                    .find(space => this.resolveEncodingConcepts(space, this.parent.encoding));
            } 

            space = space || defaults.space;
            encodings = this.resolveEncodingConcepts(space, this.parent.encoding); 

            if (!space || !encodings)
                console.warn("Could not resolve space or encoding concepts for marker.", this.parent, { space, encodings });

            return { space, encodings };
        },

        /**
         * Tries to find encoding concepts for a given space and encodings Map. Returns solution if it succeeds. Returns `undefined` if it fails.
         * @param {String[]} space 
         * @param {Map} encodings Map where keys are encoding names, values are encoding models
         * @returns {Solution|undefined} solution
         */
        resolveEncodingConcepts(space, encodings) {
            const concepts = {};
            const success = [...encodings].every(([name, enc]) => {
                // only resolve concepts for encodings which use concept property
                if (!resolveRef(enc.data.config).concept) {
                    concepts[name] = undefined;
                    return true;
                }
                const encConcept = enc.data.resolveEncodingConcept(concepts, space);
                if (encConcept !== undefined) {
                    concepts[name] = encConcept;
                    return true;
                }
                return false;
            });
            return success ? concepts : undefined;
        },

        /**
         * Tries to find encoding concept for a given space, encoding and partial solution.  
         * Should be called with encoding.data as `this`. 
         * Returns concept id which satisfies encoding definition (incl autoconfig) and does not overlap with partial solution.
         * @param {*} solution object whose keys are encoding names and values concept ids, assigned to those encodings. 
         * @param {*} space 
         * @returns {string} concept id
         */
        resolveEncodingConcept(solution, space) {
            let concept = resolveRef(this.config.concept);

            if (concept && concept.autoconfig) {
                const satisfiesAutoCfg = createFilterFn(concept.autoconfig);
                const usedConcepts = Object.values(solution);
                const spaceConcepts = space.map(c => this.source.getConcept(c));
                const availability = this.source.availability;
    
                const conceptsForThisSpace = [...availability.keyValueLookup.get(createKeyStr(space)).values()]
                    .map(kv => this.source.getConcept(kv.value))
                    // exclude the ones such as "is--country", they won't get resolved
                    .filter(c => c.concept.substr(0,4) !== "is--")
                    .concat(spaceConcepts);

                // first try unused concepts, otherwise, use already used concept
                const passedConcepts = conceptsForThisSpace.filter(satisfiesAutoCfg);
                concept = passedConcepts.find(c => !usedConcepts.includes(c.concept)) 
                    || passedConcepts[0]
                    || {};

                concept = concept.concept;
            }
            return concept || defaults.concept;    
        },
        get hasOwnData() {
            return this.source && this.concept && !this.conceptInSpace;
        },
        get promise() {
            trace();
            // can't use .then on source because its execution won't be tracked by mobx (b/c async)
            if (this.source.state === FULFILLED) {
                if (this.hasOwnData)
                    return this.source.query(this.ddfQuery)
                else   
                    return fromPromise(Promise.resolve());
            }
            // infinite pending, replaced when source is fulfilled
            return fromPromise(new Promise(() => {}));
        },
        get state() {
            return this.promise.state;
        },
        get response() {
            trace();
            const now = Date.now();
            console.log(`get response start. this.source, this.concept, this.conceptInSpace:`, this.source, this.concept, this.conceptInSpace);
            if (!this.source || !this.concept || this.conceptInSpace) {
                if (this.conceptInSpace)
                    console.warn("Encoding " + this.parent.name + " was asked for data but it has no own data. Reason: Concept in space.");
                else
                    console.warn("Encoding " + this.parent.name + " was asked for data but it has no own data.");
            }
            console.log(`get response took ${Date.now() - now}ms - latestResponse length: ${latestResponse.length}`);
            return this.promise.case({
                pending: () => latestResponse,
                rejected: e => latestResponse,
                fulfilled: (res) => latestResponse = res
            });
        },
        get responseMap() {
            trace();
            console.log("##### get responseMap", this.response);
            if (isDataFrame(this.response))
                return this.response;
            else
                return DataFrame(this.response, this.commonSpace);
        },
        get conceptInSpace() {
            return this.concept && this.space && this.space.includes(this.concept);
        },
        get ddfQuery() {
            const query = {};
            // select
            query.select = {
                key: this.space.slice(), // slice to make sure it's a normal array (not mobx)
                value: [this.concept]
            }

            // from
            query.from = (this.space.length === 1) ? "entities" : "datapoints";

            // where
            if (this.filter) {
                query.where = this.filter.whereClause(query.select.key);
            }
          
            if (this.locale) {
                query.language = this.locale; 
            }
          
            return query;
        },
    };
}