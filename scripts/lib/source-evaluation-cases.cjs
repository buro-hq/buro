// Private project definitions are deliberately excluded from this repository.
// Synthetic comparisons remain available through check-model-comparison.cjs.
function getSourceEvaluationCase() {
  throw Object.assign(new Error('No source evaluation is configured in this checkout.'), {
    code: 'EVALUATION_CASE_DISABLED',
  });
}
const prepareLiveCase = (id, options) => getSourceEvaluationCase(id).prepare(options);
module.exports = { getSourceEvaluationCase, prepareLiveCase };
