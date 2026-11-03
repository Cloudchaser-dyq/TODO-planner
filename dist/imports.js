(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlannerImports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return { batches: [] };
});
