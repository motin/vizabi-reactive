import { markerStore } from './marker/markerStore'
import { encodingStore } from './encoding/encodingStore'
import { dataSourceStore } from './dataSource/dataSourceStore'
import * as utils from './utils'
import * as mobx from 'mobx';
import { createConfig } from './config/config';

export const stores = {
    markers: markerStore,
    dataSources: dataSourceStore,
    encodings: encodingStore
}

const vizabi = function(cfg) {
    const config = createConfig(cfg, { model: stores });
    const models = {};
    for (const storeName in stores) {
        models[storeName] = stores[storeName].createMany(config[storeName] || {})
    }
    
    return models;
}
vizabi.mobx = mobx;
vizabi.utils = utils;
vizabi.stores = stores;
vizabi.dataSource = (cfg, id) =>{
    // shortcut giving data directly in array-object format: [{...},{...}]
    if (Array.isArray(cfg)) {
        cfg = {
            values: cfg
        };
    }
    cfg = createConfig(cfg);
    return dataSourceStore.create(cfg, null, id);
} 
vizabi.marker = (cfg, id) => {
    cfg = createConfig(cfg);
    return markerStore.create(cfg, null, id);
}
vizabi.encoding = (cfg, id) => {
    cfg = createConfig(cfg);
    return encodingStore.create(cfg, null, id);
}

export default vizabi;4