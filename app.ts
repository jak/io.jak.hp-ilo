'use strict';

import Homey from 'homey';

module.exports = class IloApp extends Homey.App {
  async onInit() {
    this.log('HP iLO app has been initialized');
  }
};
