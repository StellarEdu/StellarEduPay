// Shared class/grade options used by both the dashboard class filter and the
// fee-structure creation form (issue #1483). Falls back to the Nigerian
// secondary-school naming convention when a school hasn't configured its own
// `classOptions` (see backend/src/models/schoolModel.js).
export const DEFAULT_CLASS_OPTIONS = ["JSS1", "JSS2", "JSS3", "SS1", "SS2", "SS3"];

/**
 * Fetches the current school's configured class options and invokes
 * `onLoaded` with them if present. Silently keeps the default list on any
 * error or when the school hasn't configured custom classes.
 */
export function loadSchoolClassOptions(getSchool, onLoaded) {
  const schoolId = typeof window !== "undefined" ? localStorage.getItem("schoolId") : null;
  if (!schoolId) return;

  getSchool(schoolId)
    .then(({ data }) => {
      if (data.classOptions && Array.isArray(data.classOptions) && data.classOptions.length > 0) {
        onLoaded(data.classOptions);
      }
    })
    .catch(() => {
      // On error, silently fall back to defaults
    });
}
