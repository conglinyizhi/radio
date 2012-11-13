var http = require('http')
  , https = require('https')
  , httpAgent = require('http-agent')
  , urlParser = require('url')
  , throttle = require('throttle')
  , _ = require('../vendor/underscore')._
  , fs = require('fs')
  , probe = require('node-ffprobe');

function Provider(decoder, pubSub){
  if (! (this instanceof arguments.callee)){
    return new arguments.callee(arguments);
  }
  var self = this;
  
  self.pubSub = pubSub;
  self.decoder = decoder;
  self.init();
};

Provider.prototype.init = function(){
  var self = this;
  
  self.playlists = [];
  self.currentPlaylist = {};
  self.currentSong = {};
  self.apiUrl = 'http://ex.fm/api/v3';
  self.started = false;
  // self.buffer = [];
  // self.bufferSize = 44100;
  // self.bufferInterval = 1000;
}

Provider.prototype.start = function(){
  var self = this;
  self.init();
  self.started = true;
  self.trending(function(songs) {
    self.createPlaylist('Rádio da Galere - DJ automático', _(songs).map(function(song) {return song.id}), true, function() {
      self.nextPlaylist();
    });
  });
}

Provider.prototype.stop = function() {
  var self = this;
  self.init();
  self.killStream();
  self.reloadClients();
  self.started = false;
  songs = fs.readdirSync('songs');
  songs.forEach(function(song) {
    fs.unlinkSync('songs/'+song);
  });
};

Provider.prototype.killStream = function() {
  var self = this;
  if (self.currentStream){
    self.currentStream.destroy();
    self.currentStream.removeAllListeners();
  }
  if (self.currentDownload){
    self.currentDownload.destroy();
    self.currentDownload.removeAllListeners();
  }
};

Provider.prototype.reloadClients = function() {
  var self = this;
  self.publishMessage({song: 'reload'});
};

Provider.prototype.createPlaylist = function(name, ids, automatic, callback){
  var self = this;
  var songs = [];
  var agent = httpAgent.create(self.apiUrl.replace('http://', '') + '/song', ids);
  agent.on('next', function(e, res) {
    songs.push(JSON.parse(res.body).song);
    agent.next();
  });
  agent.on('stop', function(e, res) {
    var playlist = {name: name, songs: songs, id: new Date().getTime(), automatic: automatic};
    self.playlists.push(playlist);
    if (!self.currentPlaylist || self.currentPlaylist.automatic){
      self.nextPlaylist();
    }
    callback();
  });
  agent.start();
}

Provider.prototype.nextPlaylist = function(){
  var self = this;
  self.currentPlaylist = self.playlists.shift();
  if (self.currentPlaylist){
    self.nextSong();
  }else{
    self.start();
  }
}

Provider.prototype.nextSong = function(shift){
  var self = this;
  if (!self.currentPlaylist || !self.currentPlaylist.songs){
    self.nextPlaylist();
    return;
  }
  if (shift){
    self.currentPlaylist.songs.shift();
  }
  var song = self.currentPlaylist.songs[0];
  if (song){
    self.currentSong = song;
    self.publishCurrentInfo();
    var url = song.url;
    console.log('Now playing: ('+song.id+') '+ song.artist + ' - ' + song.title + ' - ' + url);
    self.treatUrl(url, function(newUrl) {
      self.downloadSong(newUrl);
    });
  }else{
    self.nextPlaylist();
  }
}

Provider.prototype.treatUrl = function(url, callback){
  var self = this;
  
  var urlObj = urlParser.parse(url, true);
  if (!url || urlObj.protocol == 'https:' || urlObj.host == 'api.soundcloud.com'){
    self.nextSong(true);
    return;
  }
  
  http.get(urlParser.parse(url), function(response){
    var headers = response.headers;
    var contentType = headers['content-type'];
    var newUrl = headers.location;
    if (contentType == 'audio/mpeg' || !newUrl){
      callback(url);
    }else{
      self.treatUrl(newUrl, callback);
    }
  });
  
}

Provider.prototype.downloadSong = function(url){
  var self = this;
  var track = 'songs/'+self.currentSong.id+'.mp3';
  console.log('downloading: '+url);
  var request = http.get(urlParser.parse(url), function(response){
    self.currentDownload = response;
    var body = '';
    response.setEncoding('binary');
    response.on('data', function(data) {
      body += data;
      // comment all of this += crap and uncomment appendFile for node 0.8+
      // fs.appendFile(track, data, function (err) {
      //   if (err) self.nextSong(true);
      // });
    });  
    response.on('error', function() {
      console.log('error when downloading!');
      self.nextSong(true);
    });
    response.on('end', function() {
      console.log(self.currentSong.id + ' ended download.');
      fs.writeFile(track, body, 'binary', function() {
        self.streamSong();
      });
      
    });  
  });
  request.on('error', function(e) {
    console.log("Error on download request: " + e.message);
  });
}

Provider.prototype.streamSong = function(){
  var self = this;
  
  self.killStream();
  
  if(!self.currentSong.id){
    return;
  }
  
  console.log('streaming: '+ self.currentSong.id);
  var track = 'songs/'+self.currentSong.id+'.mp3';
  probe(track, function(err, probeData) {
    if (!probeData || !probeData.streams){
      console.log('No sample rate info gathered, going to next song');
      self.nextSong(true);
      return;
    }
    var sample_rate = probeData.streams[0].sample_rate;
    var bit_rate = probeData.format.bit_rate;
    if (sample_rate != 44100){
      console.log('Target sample rate is not 44100, but : ' + sample_rate);
      self.nextSong(true);
      return;
    }
    if (!bit_rate){
      console.log('No bitrate info gathered, going to next song');
      self.nextSong(true);
      return;
    }
    self.currentStream = fs.createReadStream(track);
    console.log('Bitrate: ' + bit_rate);
    unthrottle = throttle(self.currentStream, (bit_rate/10) * 1.5);
    self.currentStream.on('data', function(data){
      self.decoder.pcm.stdin.write(data)   
    });
    self.currentStream.on('end', function() {
      console.log('ENDED BRO');
      fs.unlinkSync(track);
      self.nextSong(true);
    });
    self.currentStream.on('error', function() {
      console.log('ERROR BRO')
      fs.unlinkSync(track);
      self.nextSong(true);
    });
  });
}

Provider.prototype.publishMessage = function(message){
  var self = this;
  var msg = {
    channels: ['playlist'],
    data: message
  }
  self.pubSub.publish('juggernaut', JSON.stringify(msg));
}

Provider.prototype.publishCurrentInfo = function(){
  var self = this;
  var data = {playlist: self.currentPlaylist, song: self.currentSong};
  self.publishMessage(data);
}

Provider.prototype.search = function(query, callback){
  var self = this;
  self.parseSongs(self.apiUrl+'/song/search/'+query, callback);
}

Provider.prototype.trending = function(callback){
  var self = this;
  self.parseSongs(self.apiUrl+'/trending?results=10&start='+Math.floor((Math.random()*100)+1), callback);
}

Provider.prototype.parseSongs = function(url, callback){
  var self = this;
  http.get(urlParser.parse(url), function(res) {
    var body = '';
    res.on('data', function(chunk) {
      body += chunk;
    });
    res.on('end', function() {
      var json = JSON.parse(body);
      var songs = self.filterSongs(json.songs);
      callback(songs);
    });
  });
}

Provider.prototype.filterSongs = function(songs){
  return _(songs).reject(function(song) {
    var urlObj = urlParser.parse(song.url, true);
    return (!song.url || urlObj.protocol == 'https:' || urlObj.host == 'api.soundcloud.com');
  });
}


// Provider.prototype.getSongInfo = function(id, callback){
//   var self = this;
//   var song;
//   
//   http.get(self.apiUrl+'song/'+id, function(res) {
//     var body = '';
//     res.on('data', function(chunk) {
//       body += chunk;
//     });
//     res.on('end', function() {
//      var song = JSON.parse(body).song;
//      callback(song);
//     });
//   }); 
// }

// Provider.prototype.currentBufferSize = function(){
//   var self = this,
//       size = 0, 
//       i = 0, 
//       length = self.buffer.length;
//       
//   for (; i<length; i++) {
//     size += self.buffer[i].length;
//   }
//   return size;
// }

// Provider.prototype.streamSong = function(url){
//   var self = this;
//   console.log('streaming: '+url);
//   http.get(url, function(response){
//     self.currentStream = response;
//     var bufferCount = 0;
//     self.currentStream.on('data', function(data){
//       self.buffer.push(data);
//       self.decoder.pcm.stdin.write(data)
//       if (self.currentBufferSize() > self.bufferSize){
//         self.currentStream.pause();
//         setTimeout(function() {
//           self.buffer = [];
//           self.currentStream.resume();
//           bufferCount+=1;
//         }, self.bufferInterval + bufferCount * 280)
//       }     
//     });    
//     self.currentStream.on('end', function() {
//       self.nextSong(true);
//     });
//     self.currentStream.on('close', function() {
//       self.buffer = [];
//     });
//   });  
// }

// Provider.prototype.streamSong = function(url){
//   var self = this;
//   if (self.currentStream){
//     self.currentStream.destroy();
//     self.currentStream.removeAllListeners();
//   }
//   console.log('streaming: '+url);
//   http.get(url, function(response){
//     self.currentStream = response;
//     unthrottle = throttle(self.currentStream, 28000);
//     self.currentStream.on('data', function(data){
//       self.decoder.pcm.stdin.write(data)   
//     });    
//     self.currentStream.on('end', function() {
//       console.log('ENDED BRO');
//       self.nextSong(true);
//     });
//     self.currentStream.on('error', function() {
//       console.log('ERROR BRO')
//       self.nextSong(true);
//     });
//     self.currentStream.on('close', function() {
//       console.log('CLOSED BRO')
//       unthrottle();
//     });
//   });  
// }


module.exports = Provider;