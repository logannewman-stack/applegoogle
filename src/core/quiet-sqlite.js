// Importing node:sqlite prints an ExperimentalWarning, and it prints it at
// import time — before any of our own code has run. So the filter has to be
// installed by a module that is imported *before* node:sqlite is, which is the
// only reason this file exists separately.
//
// What is suppressed: one warning, matched on name and text, about Node's API
// stability policy for a feature whose behaviour our own tests pin. Every
// other warning, including any other ExperimentalWarning, passes through
// untouched.

const emit = process.emit;
process.emit = function (name, data, ...rest) {
  if (name === 'warning'
      && data?.name === 'ExperimentalWarning'
      && /\bSQLite\b/i.test(data.message || '')) {
    return false;
  }
  return emit.call(this, name, data, ...rest);
};
