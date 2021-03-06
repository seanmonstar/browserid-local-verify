/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var
https = require('https'),
wellKnownParser = require('./well-known-parser.js'),
urlparse = require('urlparse');

const WELL_KNOWN_URL = "/.well-known/browserid";

// hit the network and fetch a .well-known document in its unparsed form
var fetchWellKnown = function (emitter, args, currentDomain, principalDomain, clientCB) {
  // in many cases the http layer can send both an 'error' and an 'end'.  In
  // other cases, only 'error' will be emitted.  We want to
  // ensure the client callback is invoked only once.  this function does it.
  var startTime = new Date();
  var cb = function(err) {
    var reqTime = new Date() - startTime;

    emitter.emit('metric',
                 'elapsed_time.fetch_well_known.' + (err ? 'error' : 'success'),
                 reqTime);

    if (clientCB) {
      clientCB.apply(null, arguments);
      clientCB = null;
    }
  };

  function handleResponse(err, statusCode, headers, body) {
    if (statusCode !== 200) {
      if ([301, 302, 303, 307].indexOf(statusCode) !== -1) {
        return cb(currentDomain +
                  ' is not a browserid primary - redirection not supported for support documents');
      } else {
        return cb(currentDomain +
                  ' is not a browserid primary - non-200 response code to ' +
                  WELL_KNOWN_URL);
      }
    }
    // favor Postel over node convention
    var contentType = headers['content-type'] || headers['Content-Type'] || headers['Content-type'];
    if (!contentType || contentType.indexOf('application/json') !== 0) {
      return cb(currentDomain +
                ' is not a browserid primary - non "application/json" response to ' +
                WELL_KNOWN_URL);
    }

    cb(null, body, currentDomain);
  }

  var pathToWellKnown = WELL_KNOWN_URL + "?domain=" + principalDomain;

  emitter.emit('debug', 'fetching well-known from ' +  currentDomain + ' for principal ' +
               principalDomain);

  // If the client has provided a function to perform their own http requests,
  // use that.
  if (args.httpRequest) {
    return args.httpRequest(currentDomain, pathToWellKnown, handleResponse);
  } else {
    var port = 443;
    var host = currentDomain;
    // somewhat odd, but we do allow a host:port to be specified as a domain.
    // this supports local testing using the built in https implementation.
    if (currentDomain.indexOf(':') !== -1) {
      var s = currentDomain.split(':');
      host = s[0];
      port = s[1];
    }
    var req = https.get({
      host: host,
      port: port,
      path: pathToWellKnown,
      rejectUnauthorized: !args.insecureSSL,
      agent: false
    }, function(res) {
      var body = "";
      res.on('data', function(chunk) { body += chunk; });
      res.on('end', function() {
        handleResponse(null, res.statusCode, res.headers, body);
      });
    });
    req.end();

    // front-end shows xhr delay message after 10 sec; timeout sooner to avoid this
    var reqTimeout = setTimeout(function() {
      req.abort();
      return cb('timeout trying to load well-known for ' + currentDomain);
    }, args.httpTimeout * 1000);
    req.on('response', function() {
      if (reqTimeout) {
        clearTimeout(reqTimeout);
        reqTimeout = null;
      }
    });
    req.on('error', function(e) {
      if (reqTimeout) {
        clearTimeout(reqTimeout);
        reqTimeout = null;
      }
      return cb(currentDomain + ' is not a browserid primary: ' + String(e));
    });
  }
};

// Fetch a .well-known file from the network, following delegation
function lookup(emitter, args, currentDomain, principalDomain, cb, delegationChain) {
  if (!currentDomain) {
    currentDomain = principalDomain;
  }
  if (!principalDomain) {
    principalDomain = currentDomain;
  }
  if (!delegationChain) {
    delegationChain = [ principalDomain ];
  }

  fetchWellKnown(emitter, args, currentDomain, principalDomain, function(err, unparsedDoc) {
    if (err) {
      return cb(err);
    }

    var supportDoc;
    try {
      var allowURLOmission = args.allowURLOmission || currentDomain === args.fallback;
      supportDoc = wellKnownParser(unparsedDoc, allowURLOmission);
    } catch (e) {
      return cb("bad support document for '" + currentDomain + "': " + String(e));
    }

    if (supportDoc.type === 'disabled')
    {
      return cb(null, {
        disabled: true,
        delegationChain: delegationChain,
        authoritativeDomain: delegationChain[delegationChain.length - 1],
      });
    }
    else if (supportDoc.type === 'delegation')
    {
      currentDomain = supportDoc.authority;

      // check for cycles in delegation
      if (delegationChain.indexOf(currentDomain) !== -1) {
        return cb("Circular reference in delegating authority: " + delegationChain.join(" > "));
      }

      delegationChain.push(currentDomain);

      emitter.emit('debug', delegationChain[delegationChain.length - 2] + " delegates to " +
                   delegationChain[delegationChain.length - 1]);

      // check for max delegation length (max delegations of n, implies we can have a chain
      // length of n + 1.  IOW, a chain of length 10, has 9 authority delegations.
      if (delegationChain.length > (args.maxDelegations + 1)) {
        return cb("Too many hops while delegating authority: " + delegationChain.join(" > "));
      }

      // recurse
      return lookup(emitter, args, currentDomain, principalDomain, cb, delegationChain);
    }
    else if (supportDoc.type === 'supported')
    {
      var url_prefix = 'https://' + currentDomain;

      var details = {
        publicKey: supportDoc.publicKey,
        delegationChain: delegationChain,
        authoritativeDomain: delegationChain[delegationChain.length - 1],
        urls: {
        }
      };

      // the well know parser has verified that urls are present unless
      // allowURLOmission is specified.  Now we'll validate urls are
      // correct if they have been supplied
      try {
        if (supportDoc.paths.authentication) {
          details.urls.auth = url_prefix + supportDoc.paths.authentication;
          urlparse(details.urls.auth).validate();
        }
        if (supportDoc.paths.provisioning) {
          details.urls.prov = url_prefix + supportDoc.paths.provisioning;
          urlparse(details.urls.prov).validate();
        }
      } catch(e) {
        return cb("invalid URL in support document: " + e.toString());
      }

      // success!
      cb(null, details);
    }
    else
    {
      var msg = "unhandled error while parsing support document for " + currentDomain;
      return cb(msg);
    }
  });
}

module.exports = function (browserid, args, cb) {
  lookup(browserid, args, args.domain, args.principalDomain, function(err, details) {
    // if there is an error, then let's try the fallback if configured
    if (err && args.fallback) {
      return lookup(browserid, args, args.fallback, args.principalDomain, cb, [ args.fallback ]);
    }
    cb(err, details);
  });
};
