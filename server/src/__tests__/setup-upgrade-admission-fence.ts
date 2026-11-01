import { configureUpgradeAdmissionFenceMode } from "../services/upgrade-admission-fence.js";

// Server suites build services against pre-migrated databases that never ran
// the server boot, so they have no upgrade admission fence row. Production
// refuses run claims on an absent row; tests that never booted a server admit
// them. Suites that test the fence itself select "required" per case.
configureUpgradeAdmissionFenceMode("test_absent_open");
