import { test, expect } from "./emulator-fixtures";
import { defineFidelitySuite } from "./fidelity-suite";

defineFidelitySuite(test, expect);

import { defineNativeViewportFitTests } from "./native-viewport-fit";
defineNativeViewportFitTests();

import { defineNativeOwnerOrderTests } from "./native-owner-order";
defineNativeOwnerOrderTests();
import { defineNativeRecheckProgressTests } from "./native-recheck-progress";
defineNativeRecheckProgressTests();

import { defineNativeLateAttachTests } from "./native-late-attach";
defineNativeLateAttachTests();

import { defineNativeProbeProgressTests } from "./native-probe-progress";
defineNativeProbeProgressTests();
