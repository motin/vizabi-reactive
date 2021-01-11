import { dataConfig } from './dataConfig';
import { composeObj, fromPromiseAll, renameProperty } from '../utils';
import { trace, toJS, observable } from 'mobx';
import { fromPromise } from 'mobx-utils';
import { DataFrame } from '../../dataframe/dataFrame';
import { createConfig } from '../config/config';

export function entityPropertyDataConfig(cfg, parent) {
    return observable(
        entityPropertyDataConfig.nonObservable(createConfig(cfg), parent), {
        config: observable.ref
    });
}
entityPropertyDataConfig.nonObservable = function (cfg, parent) {
    const base = dataConfig.nonObservable(cfg, parent);

    return composeObj(base, {

        get promise() {
            const sourcePromises = [];

            sourcePromises.push(this.source.metaDataPromise);
            if (this.needsMarkerSource) { sourcePromises.push(this.marker.data.source.metaDataPromise); }
            if (sourcePromises.length > 0) {
                const combined = fromPromiseAll(sourcePromises);
                return combined.case({ 
                    fulfilled: () => this.sendQueries(),
                    pending: () => combined,
                })
            } else {
                return this.sendQueries();
            }
        },
        sendQueries() {
            const labelPromises = this.queries.map(query => this.source.query(query)
                .then(data => ({ dim: query.select.key[0], data }))
            );
            return fromPromise(Promise.all(labelPromises))
        },
        get queries() {
            const entityDims = this.space.filter(dim => this.source.isEntityConcept(dim));
            return entityDims.map(dim => ({
                select: {
                    key: [dim],
                    value: [this.concept]
                },
                from: "entities"
            }));
        },
        get lookups() {
            const concept = this.concept;
            const lookups = new Map();
            this.response.forEach(response => {
                const { dim, data } = response;
                const lookup = new Map();
                lookups.set(dim, lookup);
                data.forEach(row => {
                    lookup.set(row[dim], row[concept]);
                })
            });
            return new Map([[this.concept, lookups]]);
        },
        get responseMap() {
            return DataFrame.fromLookups(this.lookups, this.space)
        },
        addLabels(markers, encName) {
            // reduce lookups
            const space = toJS(this.space);
            const lookups = this.lookups;
            markers.forEach((marker, key) => {
                const label = {};
                space.forEach(dim => {
                    if (lookups.has(dim))
                        label[dim] = lookups.get(dim).get(marker[dim]);
                    else
                        label[dim] = marker[dim];
                });
                marker[encName] = label;
            });
        }
    })
}