# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

// This is the only implementation of nsIUrlListManager.
// A class that manages lists, namely white and black lists for
// phishing or malware protection. The ListManager knows how to fetch,
// update, and store lists.
//
// There is a single listmanager for the whole application.
//
// TODO more comprehensive update tests, for example add unittest check 
//      that the listmanagers tables are properly written on updates

// Log only if browser.safebrowsing.debug is true
var debug = false;
function log(...stuff) {
  if (!debug) {
    return;
  }

  let msg = "listmanager: " + stuff.join(" ");
  dump(msg + "\n");
}

function QueryAdapter(callback) {
  this.callback_ = callback;
};

QueryAdapter.prototype.handleResponse = function(value) {
  this.callback_.handleEvent(value);
}

/**
 * A ListManager keeps track of black and white lists and knows
 * how to update them.
 *
 * @constructor
 */
function PROT_ListManager() {
  this.prefs_ = new G_Preferences();
  this.updateInterval = this.prefs_.getPref("urlclassifier.updateinterval", 30 * 60) * 1000;

  // A map of tableNames to objects of type
  // { updateUrl: <updateUrl>, gethashUrl: <gethashUrl> }
  this.tablesData = {};
  // A map of updateUrls to maps of tables requiring updates, e.g.
  // { safebrowsing-update-url: { goog-phish-shavar: true,
  //                              goog-malware-shavar: true }
  this.needsUpdate_ = {};

  this.observerServiceObserver_ = new G_ObserverServiceObserver(
                                          'quit-application',
                                          BindToObject(this.shutdown_, this),
                                          true /*only once*/);

  this.updateCheckers_ = {};
  this.requestBackoffs_ = {};
  this.dbService_ = Cc["@mozilla.org/url-classifier/dbservice;1"]
                   .getService(Ci.nsIUrlClassifierDBService);


  this.hashCompleter_ = Cc["@mozilla.org/url-classifier/hashcompleter;1"]
                        .getService(Ci.nsIUrlClassifierHashCompleter);
  debug = this.prefs_.getPref("browser.safebrowsing.debug");
}

/**
 * xpcom-shutdown callback
 * Delete all of our data tables which seem to leak otherwise.
 */
PROT_ListManager.prototype.shutdown_ = function() {
  for (var name in this.tablesData) {
    delete this.tablesData[name];
  }
}

/**
 * Register a new table table
 * @param tableName - the name of the table
 * @param updateUrl - the url for updating the table
 * @param gethashUrl - the url for fetching hash completions
 * @returns true if the table could be created; false otherwise
 */
PROT_ListManager.prototype.registerTable = function(tableName,
                                                    updateUrl,
                                                    gethashUrl) {
  log("registering " + tableName + " with " + updateUrl);
  if (!updateUrl) {
    log("Can't register table " + tableName + " without updateUrl");
    return false;
  }
  this.tablesData[tableName] = {};
  this.tablesData[tableName].updateUrl = updateUrl;
  this.tablesData[tableName].gethashUrl = gethashUrl;

  // Keep track of all of our update URLs.
  if (!this.needsUpdate_[updateUrl]) {
    this.needsUpdate_[updateUrl] = {};
    /* Backoff interval should be between 30 and 60 minutes. */
    var backoffInterval = 30 * 60 * 1000;
    backoffInterval += Math.floor(Math.random() * (30 * 60 * 1000));

    log("Creating request backoff for " + updateUrl);
    this.requestBackoffs_[updateUrl] = new RequestBackoff(2 /* max errors */,
                                      60*1000 /* retry interval, 1 min */,
                                            4 /* num requests */,
                                   60*60*1000 /* request time, 60 min */,
                              backoffInterval /* backoff interval, 60 min */,
                                 8*60*60*1000 /* max backoff, 8hr */);

  }
  this.needsUpdate_[updateUrl][tableName] = false;

  return true;
}

PROT_ListManager.prototype.getGethashUrl = function(tableName) {
  if (this.tablesData[tableName] && this.tablesData[tableName].gethashUrl) {
    return this.tablesData[tableName].gethashUrl;
  }
  return "";
}

/**
 * Enable updates for some tables
 * @param tables - an array of table names that need updating
 */
PROT_ListManager.prototype.enableUpdate = function(tableName) {
  var changed = false;
  var table = this.tablesData[tableName];
  if (table) {
    log("Enabling table updates for " + tableName);
    this.needsUpdate_[table.updateUrl][tableName] = true;
    changed = true;
  }

  if (changed) {
    this.maybeToggleUpdateChecking();
  }
}

/**
 * Disables updates for some tables
 * @param tables - an array of table names that no longer need updating
 */
PROT_ListManager.prototype.disableUpdate = function(tableName) {
  var changed = false;
  var table = this.tablesData[tableName];
  if (table) {
    log("Disabling table updates for " + tableName);
    this.needsUpdate_[table.updateUrl][tableName] = false;
    changed = true;
  }

  if (changed) {
    this.maybeToggleUpdateChecking();
  }
}

/**
 * Determine if we have some tables that need updating.
 */
PROT_ListManager.prototype.requireTableUpdates = function() {
  for (var name in this.tablesData) {
    // Tables that need updating even if other tables don't require it
    if (this.needsUpdate_[this.tablesData[name].updateUrl][name]) {
      return true;
    }
  }

  return false;
}

/**
 * Acts as a nsIUrlClassifierCallback for getTables.
 */
PROT_ListManager.prototype.kickoffUpdate_ = function (onDiskTableData)
{
  this.startingUpdate_ = false;
  var initialUpdateDelay = 3000;

  // Check if any table registered for updates has ever been downloaded.
  var updatingExisting = false;
  for (var tableName in this.tablesData) {
    if (this.needsUpdate_[this.tablesData[tableName].updateUrl][tableName]) {
      if (onDiskTableData.indexOf(tableName) != -1) {
        updatingExisting = true;
      }
    }
  }

  // If the user has never downloaded tables, do the check now.
  log("needsUpdate: " + JSON.stringify(this.needsUpdate_, undefined, 2));
  for (var url in this.needsUpdate_) {
    // If the user has tables, add a fuzz of a few minutes.
    if (updatingExisting) {
      // Add a fuzz of 0-5 minutes.
      initialUpdateDelay += Math.floor(Math.random() * (5 * 60 * 1000));
    }
    // If we haven't already kicked off updates for this updateUrl, set a
    // repeating timer for it. The delay will be reset either on updateSuccess
    // to this.updateinterval, or backed off on downloadError.
    if (!this.updateCheckers_[url]) {
      this.updateCheckers_[url] =
        new G_Alarm(BindToObject(this.checkForUpdates, this, url),
                    initialUpdateDelay, true /* repeating */);
    }
  }
}

PROT_ListManager.prototype.stopUpdateCheckers = function() {
  log("Stopping updates");
  for (var updateUrl in this.updateCheckers_) {
    this.updateCheckers_[updateUrl].cancel();
    this.updateCheckers_[updateUrl] = null;
  }
}

/**
 * Determine if we have any tables that require updating.  Different
 * Wardens may call us with new tables that need to be updated.
 */ 
PROT_ListManager.prototype.maybeToggleUpdateChecking = function() {
  // We update tables if we have some tables that want updates.  If there
  // are no tables that want to be updated - we dont need to check anything.
  if (this.requireTableUpdates()) {
    log("Starting managing lists");

    // Get the list of existing tables from the DBService before making any
    // update requests.
    if (!this.startingUpdate_) {
      this.startingUpdate_ = true;
      // check the current state of tables in the database
      this.dbService_.getTables(BindToObject(this.kickoffUpdate_, this));
    }
  } else {
    log("Stopping managing lists (if currently active)");
    this.stopUpdateCheckers();                    // Cancel pending updates
  }
}

/**
 * Provides an exception free way to look up the data in a table. We
 * use this because at certain points our tables might not be loaded,
 * and querying them could throw.
 *
 * @param table String Name of the table that we want to consult
 * @param key Principal being used to lookup the database
 * @param callback nsIUrlListManagerCallback (ie., Function) given false or the
 *        value in the table corresponding to key.  If the table name does not
 *        exist, we return false, too.
 */
PROT_ListManager.prototype.safeLookup = function(key, callback) {
  try {
    log("safeLookup: " + key);
    var cb = new QueryAdapter(callback);
    this.dbService_.lookup(key,
                           BindToObject(cb.handleResponse, cb),
                           true);
  } catch(e) {
    log("safeLookup masked failure for key " + key + ": " + e);
    callback.handleEvent("");
  }
}

/**
 * Updates our internal tables from the update server
 *
 * @param updateUrl: request updates for tables associated with that url, or
 * for all tables if the url is empty.
 */
PROT_ListManager.prototype.checkForUpdates = function(updateUrl) {
  log("checkForUpdates with " + updateUrl);
  // See if we've triggered the request backoff logic.
  if (!updateUrl) {
    return false;
  }
  if (!this.requestBackoffs_[updateUrl] ||
      !this.requestBackoffs_[updateUrl].canMakeRequest()) {
    return false;
  }
  // Grab the current state of the tables from the database
  this.dbService_.getTables(BindToObject(this.makeUpdateRequest_, this,
                            updateUrl));
  return true;
}

/**
 * Method that fires the actual HTTP update request.
 * First we reset any tables that have disappeared.
 * @param tableData List of table data already in the database, in the form
 *        tablename;<chunk ranges>\n
 */
PROT_ListManager.prototype.makeUpdateRequest_ = function(updateUrl, tableData) {
  log("this.tablesData: " + JSON.stringify(this.tablesData, undefined, 2));
  log("existing chunks: " + tableData + "\n");
  // Disallow blank updateUrls
  if (!updateUrl) {
    return;
  }
  // An object of the form
  // { tableList: comma-separated list of tables to request,
  //   tableNames: map of tables that need updating,
  //   request: list of tables and existing chunk ranges from tableData
  // }
  var streamerMap = { tableList: null, tableNames: {}, request: "" };
  for (var tableName in this.tablesData) {
    // Skip tables not matching this update url
    if (this.tablesData[tableName].updateUrl != updateUrl) {
      continue;
    }
    if (this.needsUpdate_[this.tablesData[tableName].updateUrl][tableName]) {
      streamerMap.tableNames[tableName] = true;
    }
    if (!streamerMap.tableList) {
      streamerMap.tableList = tableName;
    } else {
      streamerMap.tableList += "," + tableName;
    }
  }
  // Build the request. For each table already in the database, include the
  // chunk data from the database
  var lines = tableData.split("\n");
  for (var i = 0; i < lines.length; i++) {
    var fields = lines[i].split(";");
    var name = fields[0];
    if (streamerMap.tableNames[name]) {
      streamerMap.request += lines[i] + "\n";
      delete streamerMap.tableNames[name];
    }
  }
  // For each requested table that didn't have chunk data in the database,
  // request it fresh
  for (let tableName in streamerMap.tableNames) {
    streamerMap.request += tableName + ";\n";
  }

  log("update request: " + JSON.stringify(streamerMap, undefined, 2) + "\n");

  if (Object.keys(streamerMap.tableNames).length > 0) {
    this.makeUpdateRequestForEntry_(updateUrl, streamerMap.tableList,
                                    streamerMap.request);
  }
}

PROT_ListManager.prototype.makeUpdateRequestForEntry_ = function(updateUrl,
                                                                 tableList,
                                                                 request) {
  log("makeUpdateRequestForEntry_: request " + request + " update: " +
      updateUrl + " tablelist: " + tableList + "\n");
  var streamer = Cc["@mozilla.org/url-classifier/streamupdater;1"]
                 .getService(Ci.nsIUrlClassifierStreamUpdater);

  this.requestBackoffs_[updateUrl].noteRequest();

  if (!streamer.downloadUpdates(
        tableList,
        request,
        updateUrl,
        BindToObject(this.updateSuccess_, this, tableList, updateUrl),
        BindToObject(this.updateError_, this, tableList, updateUrl),
        BindToObject(this.downloadError_, this, tableList, updateUrl))) {
    log("pending update, wait until later");
  }
}

/**
 * Callback function if the update request succeeded.
 * @param waitForUpdate String The number of seconds that the client should
 *        wait before requesting again.
 */
PROT_ListManager.prototype.updateSuccess_ = function(tableList, updateUrl,
                                                     waitForUpdate) {
  log("update success for " + tableList + " from " + updateUrl + ": " +
      waitForUpdate + "\n");
  if (waitForUpdate) {
    var delay = parseInt(waitForUpdate, 10);
    // As long as the delay is something sane (5 minutes or more), update
    // our delay time for requesting updates. Setting the delay requires a
    // repeating timer, so always use one.
    if (delay >= (5 * 60) && this.updateCheckers_[updateUrl]) {
      log("Waiting " + delay);
      this.updateCheckers_[updateUrl].setDelay(delay * 1000);
    } else {
      log("Ignoring delay from server, waiting " + this.updateInterval);
      this.updateCheckers_[updateUrl].setDelay(this.updateInterval);
    }
  }

  // Let the backoff object know that we completed successfully.
  this.requestBackoffs_[updateUrl].noteServerResponse(200);
}

/**
 * Callback function if the update request succeeded.
 * @param result String The error code of the failure
 */
PROT_ListManager.prototype.updateError_ = function(table, updateUrl, result) {
  log("update error for " + table + " from " + updateUrl + ": " + result + "\n");
  // XXX: there was some trouble applying the updates.
}

/**
 * Callback function when the download failed
 * @param status String http status or an empty string if connection refused.
 */
PROT_ListManager.prototype.downloadError_ = function(table, updateUrl, status) {
  log("download error for " + table + ": " + status + "\n");
  // If status is empty, then we assume that we got an NS_CONNECTION_REFUSED
  // error.  In this case, we treat this is a http 500 error.
  if (!status) {
    status = 500;
  }
  status = parseInt(status, 10);
  this.requestBackoffs_[updateUrl].noteServerResponse(status);
  if (this.requestBackoffs_[updateUrl].isErrorStatus(status)) {
    // Schedule an update for when our backoff is complete
    this.updateCheckers_[updateUrl].setDelay(
      this.requestBackoffs_[updateUrl].nextRequestDelay());
  }
}

PROT_ListManager.prototype.QueryInterface = function(iid) {
  if (iid.equals(Ci.nsISupports) ||
      iid.equals(Ci.nsIUrlListManager) ||
      iid.equals(Ci.nsITimerCallback))
    return this;

  throw Components.results.NS_ERROR_NO_INTERFACE;
}
