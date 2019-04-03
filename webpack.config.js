const path = require('path');

module.exports = {
    mode: 'development',
    entry: {
        Vizabi: './src/core/vizabi.js',
        Dataframe: './src/dataframe/dataFrame.js'
    },
    output: {
        filename: '[name].js',
        path: path.resolve(__dirname, 'dist'),
        library: '[name]',
        libraryExport: 'default'
    },

    devServer: {
        contentBase: path.join(__dirname, 'dist'),
        compress: false,
        port: 9000
    }
};