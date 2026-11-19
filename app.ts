'use strict';

import Homey from 'homey';

module.exports = class IloApp extends Homey.App {
  async onInit() {
    // The runtime Node version gates dependency upgrades (e.g. undici 8 needs
    // Node >=22.19) and Homey doesn't document the exact minor, so record it.
    this.log(`HP iLO app has been initialized (Node ${process.version})`);
  }
};
