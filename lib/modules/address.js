'use strict';

var BaseModule = require('../module');
var inherits = require('util').inherits;
var async = require('async');
var chainlib = require('chainlib');
var log = chainlib.log;
var errors = chainlib.errors;
var bitcore = require('bitcore');
var PublicKey = bitcore.PublicKey;
var Address = bitcore.Address;

var AddressModule = function(options) {
  BaseModule.call(this, options);
};

inherits(AddressModule, BaseModule);

AddressModule.PREFIXES = {
  OUTPUTS: 'outs'
};

AddressModule.prototype.getAPIMethods = function() {
  return [
    ['getBalance', this, this.getBalance, 2],
    ['getOutputs', this, this.getOutputs, 2],
    ['getUnspentOutputs', this, this.getUnspentOutputs, 2],
    ['isSpent', this, this.isSpent, 2]
  ];
};

AddressModule.prototype.blockHandler = function(block, addOutput, callback) {
  var txs = this.db.getTransactionsFromBlock(block);

  var action = 'put';
  if (!addOutput) {
    action = 'del';
  }

  var operations = [];

  var transactionLength = txs.length;
  for (var i = 0; i < transactionLength; i++) {

    var tx = txs[i];
    var txid = tx.id;
    var inputs = tx.inputs;
    var outputs = tx.outputs;

    var outputLength = outputs.length;
    for (var j = 0; j < outputLength; j++) {
      var output = outputs[j];

      var script = output.script;

      if(!script) {
        log.debug('Invalid script');
        continue;
      }

      var addressHashBuffer;

      if (script.isPublicKeyHashOut()) {
        addressHashBuffer = script.chunks[2].buf;
      } else if (script.isScriptHashOut()) {
        addressHashBuffer = script.chunks[1].buf;
      } else if (script.isPublicKeyOut()) {
        var pubkey = script.chunks[0].buf;
        var address = Address.fromPublicKey(new PublicKey(pubkey), this.db.network);
        addressHashBuffer = address.hashBuffer;
      }

      var outputIndex = j;
      var timestamp = block.timestamp.getTime();
      var height = block.__height;

      var addressHashHex = addressHashBuffer.toString('hex');
      var scriptHex = output._scriptBuffer.toString('hex');

      var key = [AddressModule.PREFIXES.OUTPUTS, addressHashHex, timestamp, txid, outputIndex].join('-');
      var value = [output.satoshis, scriptHex, height].join(':');

      operations.push({
        type: action,
        key: key,
        value: value
      });

    }

    if(tx.isCoinbase()) {
      continue;
    }

  }

  setImmediate(function() {
    callback(null, operations);
  });
};

AddressModule.prototype.getBalance = function(address, queryMempool, callback) {
  this.getUnspentOutputs(address, queryMempool, function(err, outputs) {
    if(err) {
      return callback(err);
    }

    var satoshis = outputs.map(function(output) {
      return output.satoshis;
    });

    var sum = satoshis.reduce(function(a, b) {
      return a + b;
    }, 0);

    return callback(null, sum);
  });
};

AddressModule.prototype.getOutputs = function(address, queryMempool, callback) {
  var self = this;

  // decode the base58check encoding
  var addressDecoded = Address.fromString(address);
  var addressHash = addressDecoded.hashBuffer.toString('hex');

  var outputs = [];
  var key = [AddressModule.PREFIXES.OUTPUTS, addressHash].join('-');

  var stream = this.db.store.createReadStream({
    start: key,
    end: key + '~'
  });

  stream.on('data', function(data) {

    var key = data.key.split('-');
    var value = data.value.split(':');

    var output = {
      address: address,
      txid: key[3],
      outputIndex: Number(key[4]),
      satoshis: Number(value[0]),
      script: value[1],
      blockHeight: Number(value[2])
    };

    outputs.push(output);

  });

  var error;

  stream.on('error', function(streamError) {
    if (streamError) {
      error = streamError;
    }
  });

  stream.on('close', function() {
    if (error) {
      return callback(error);
    }

    if(queryMempool) {
      outputs = outputs.concat(self.db.bitcoind.getMempoolOutputs(address));
    }

    callback(null, outputs);
  });

  return stream;

};

AddressModule.prototype.getUnspentOutputs = function(address, queryMempool, callback) {

  var self = this;

  this.getOutputs(address, queryMempool, function(err, outputs) {
    if (err) {
      return callback(err);
    } else if(!outputs.length) {
      return callback(new errors.NoOutputs('Address ' + address + ' has no outputs'), []);
    }

    var isUnspent = function(output, callback) {
      self.isUnspent(output, queryMempool, callback);
    };

    async.filter(outputs, isUnspent, function(results) {
      callback(null, results);
    });
  });
};

AddressModule.prototype.isUnspent = function(output, queryMempool, callback) {
  this.isSpent(output, queryMempool, function(spent) {
    callback(!spent);
  });
};

AddressModule.prototype.isSpent = function(output, queryMempool, callback) {
  var self = this;
  var txid = output.prevTxId ? output.prevTxId.toString('hex') : output.txid;

  setImmediate(function() {
    callback(self.db.bitcoind.isSpent(txid, output.outputIndex));
  });
};

module.exports = AddressModule;
