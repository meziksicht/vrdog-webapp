const path = require('path');

module.exports = {
  entry: './client/src/index.js',  // Your entry file where the code starts
  output: {
    filename: 'bundle.js',  // Output file
    path: path.resolve(__dirname+"/client", 'dist'),  // Output directory
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',  // Babel loader to transpile JS
        },
      },
    ],
  },
  resolve: {
    alias: {
      mediasoupClient: path.resolve(__dirname, 'node_modules/mediasoup-client')
    }
  },
  mode: 'development',  // Use 'production' for production build
};
