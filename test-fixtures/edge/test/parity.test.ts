import test from 'node:test';
import { defineParitySuite } from '../src/sharedSuite';

// No static registrations here: the suite is defined by a helper.
defineParitySuite(test);
