import { getProjectConfig } from './get-project-config';
import { showResourceTable } from './resource-status';
import { onCategoryOutputsChange } from './on-category-outputs-change';
import { initializeEnv } from '../../initialize-env';
import { getProviderPlugins } from './get-provider-plugins';
import { getEnvInfo } from './get-env-info';
import { EnvironmentDoesNotExistError, exitOnNextTick, stateManager, $TSAny, $TSContext, CustomPoliciesFormatError } from 'amplify-cli-core';
import { printer } from 'amplify-prompts';

export async function pushResources(
  context: $TSContext,
  category?: string,
  resourceName?: string,
  filteredResources?: { category: string; resourceName: string }[],
) {
  if (context.parameters.options['iterative-rollback']) {
    // validate --iterative-rollback with --force
    if (context.parameters.options.force) {
      throw new Error(
        "'--iterative-rollback' and '--force' cannot be used together. Consider runnning 'amplify push --force' to iteratively rollback and redeploy.",
      );
    }
    context.exeInfo.iterativeRollback = true;
  }
  if (context.parameters.options.env) {
    const envName: string = context.parameters.options.env;
    const allEnvs = context.amplify.getAllEnvs();

    if (allEnvs.findIndex(env => env === envName) !== -1) {
      context.exeInfo = {};
      context.exeInfo.forcePush = false;

      context.exeInfo.projectConfig = stateManager.getProjectConfig(undefined, {
        throwIfNotExist: false,
      });

      context.exeInfo.localEnvInfo = getEnvInfo();
      if (context.exeInfo.localEnvInfo.envName !== envName) {
        context.exeInfo.localEnvInfo.envName = envName;
        stateManager.setLocalEnvInfo(context.exeInfo.localEnvInfo.projectPath, context.exeInfo.localEnvInfo);
      }
      await initializeEnv(context);
    } else {
      const errMessage = "Environment doesn't exist. Please use 'amplify init' to create a new environment";

      context.print.error(errMessage);
      await context.usageData.emitError(new EnvironmentDoesNotExistError(errMessage));

      exitOnNextTick(1);
    }
  }

  const hasChanges = await showResourceTable(category, resourceName, filteredResources);

  // no changes detected
  if (!hasChanges && !context.exeInfo.forcePush) {
    context.print.info('\nNo changes detected');

    return context;
  }

  let continueToPush = context.exeInfo && context.exeInfo.inputParams && context.exeInfo.inputParams.yes;

  if (!continueToPush) {
    if (context.exeInfo.iterativeRollback) {
      context.print.info('The CLI will rollback the last known iterative deployment.');
    }
    continueToPush = await context.amplify.confirmPrompt('Are you sure you want to continue?');
  }

  if (continueToPush) {
    try {
      // Get current-cloud-backend's amplify-meta
      const currentAmplifyMeta = stateManager.getCurrentMeta();

      await providersPush(context, category, resourceName, filteredResources);
      await onCategoryOutputsChange(context, currentAmplifyMeta);
    } catch (err) {
      // Handle the errors and print them nicely for the user.
      if (!(err instanceof CustomPoliciesFormatError)) {
        printer.error(`\n${err.message}`);
      }
      throw err;
    }
  } else {
    // there's currently no other mechanism to stop the execution of the postPush workflow in this case, so exiting here
    exitOnNextTick(1);
  }

  return continueToPush;
}

async function providersPush(context: $TSContext, category, resourceName, filteredResources) {
  const { providers } = getProjectConfig();
  const providerPlugins = getProviderPlugins(context);
  const providerPromises: (() => Promise<$TSAny>)[] = [];

  for (const provider of providers) {
    const providerModule = require(providerPlugins[provider]);
    const resourceDefiniton = await context.amplify.getResourceStatus(category, resourceName, provider, filteredResources);
    providerPromises.push(providerModule.pushResources(context, resourceDefiniton));
  }

  await Promise.all(providerPromises);
}

export async function storeCurrentCloudBackend(context: $TSContext) {
  const { providers } = getProjectConfig();
  const providerPlugins = getProviderPlugins(context);
  const providerPromises: (() => Promise<$TSAny>)[] = [];

  for (const provider of providers) {
    const providerModule = require(providerPlugins[provider]);
    providerPromises.push(providerModule.storeCurrentCloudBackend(context));
  }

  await Promise.all(providerPromises);
}
