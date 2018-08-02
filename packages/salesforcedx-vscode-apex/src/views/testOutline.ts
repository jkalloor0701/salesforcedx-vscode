/*
 * Copyright (c) 2017, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import * as vscode from 'vscode';
import crypto = require('crypto');
import events = require('events');
import fs = require('fs');
// import shell = require('shelljs');
import ospath = require('path');
import {
  CliCommandExecutor,
  Command
} from '@salesforce/salesforcedx-utils-vscode/out/src/cli';
import { ContinueResponse } from '@salesforce/salesforcedx-utils-vscode/out/src/types';
import { ApexTestRequestInfo, getApexClassFiles, getApexTests, isLanguageClientReady } from '..';
import {
  DARK_BLUE_BUTTON,
  DARK_GREEN_BUTTON,
  DARK_RED_BUTTON,
  LIGHT_BLUE_BUTTON,
  LIGHT_GREEN_BUTTON,
  LIGHT_RED_BUTTON
} from '../constants';
import { nls } from '../messages';
import { FullTestResult, TestSummarizer } from './TestDataAccessObjects';

// Import from core
const sfdxCoreExports = vscode.extensions.getExtension(
  'salesforce.salesforcedx-vscode-core'
)!.exports;
const ProgressNotification = sfdxCoreExports.ProgressNotification;
const EmptyParametersGatherer = sfdxCoreExports.EmptyParametersGatherer;
const SfdxCommandlet = sfdxCoreExports.SfdxCommandlet;
const ForceApexTestRunCodeActionExecutor =
  sfdxCoreExports.ForceApexTestRunCodeActionExecutor;
const SfdxWorkspaceChecker = sfdxCoreExports.SfdxWorkspaceChecker;
const channelService = sfdxCoreExports.channelService;
const notificationService = sfdxCoreExports.notificationService;
const taskViewService = sfdxCoreExports.taskViewService;

export class ApexTestOutlineProvider implements vscode.TreeDataProvider<Test> {
  private onDidChangeTestData: vscode.EventEmitter<
    Test | undefined
    > = new vscode.EventEmitter<Test | undefined>();
  public onDidChangeTreeData = this.onDidChangeTestData.event;

  private eventsEmitter = new events.EventEmitter();

  private apexTestMap: Map<string, Test> = new Map<string, Test>();
  private container: Test | null;
  private static testStrings: Set<string> = new Set<string>();
  private path: string;
  private apexClasses: vscode.Uri[];
  private apexTestInfo: ApexTestRequestInfo[] | null;

  constructor(
    path: string,
    apexClasses: vscode.Uri[],
    apexTestInfo: ApexTestRequestInfo[] | null
  ) {
    this.container = null;
    this.path = path;
    this.apexClasses = apexClasses;
    this.apexTestInfo = apexTestInfo;
    this.getAllApexTests(this.path);
    // Now, activate events that we need
    this.eventsEmitter.on('Delete Folder', this.deleteFolder); // Activate event to delete folder
    this.eventsEmitter.on('Show Highlight', this.updateSelection);
  }

  public getHead(): Test {
    if (this.container === null) {
      return this.getAllApexTests(this.path);
    }
    return this.container;
  }

  public getChildren(element: Test): Test[] {
    if (element) {
      return element.children;
    } else {
      if (this.container && this.container.children.length > 0) {
        return this.container.children;
      } else {
        const emptyArray = new Array<ApexTest>();
        emptyArray.push(new ApexTest('No tests in folder', null, 0));
        return emptyArray;
      }
    }
  }

  public getTreeItem(element: Test): vscode.TreeItem {
    if (element) {
      return element;
    } else {
      this.getAllApexTests(this.path);
      if (!(this.container && this.container.children.length > 0)) {
        this.container = new ApexTest('No tests in folder', null, 0);
        this.container.children.push(new ApexTest('No tests in folder', null, 0));
      }
      return this.container;
    }
  }

  public async refresh() {
    this.container = null; // Reset tests
    this.apexTestMap.clear();
    ApexTestOutlineProvider.testStrings.clear();
    this.apexTestInfo = null;
    if (isLanguageClientReady()) {
      this.apexTestInfo = await getApexTests();
    }
    this.apexClasses = await getApexClassFiles();
    this.getAllApexTests(this.path);
    this.onDidChangeTestData.fire();
  }

  private getAllApexTests(path: string): Test {
    if (this.container == null) {
      // Starting Out
      this.container = new ApexTestGroup('ApexTests', null, 1);
    }
    // Check if lsp worked, else parse files manually
    if (this.apexTestInfo) {
      // Do it the easy way
      this.apexTestInfo.forEach(test => {
        let apexGroup = this.apexTestMap.get(
          test.definingType
        ) as ApexTestGroup;
        if (!apexGroup) {
          apexGroup = new ApexTestGroup(test.definingType, null, 1);
          this.apexTestMap.set(test.definingType, apexGroup);
        }
        const testUri = vscode.Uri.file(test.file.substring(7));
        const apexTest = new ApexTest(
          test.methodName,
          testUri,
          test.position.line
        );
        apexTest.name = apexGroup.label + '.' + apexTest.label;
        this.apexTestMap.set(apexTest.name, apexTest);
        apexGroup.children.push(apexTest);
        if (this.container && !(this.container.children.indexOf(apexGroup) >= 0)) {
          this.container.children.push(apexGroup);
        }
        ApexTestOutlineProvider.testStrings.add(apexGroup.name);
      });
    } else {
      this.apexClasses.forEach(apexClass => {
        const fileContent = fs.readFileSync(apexClass.fsPath).toString();
        if (fileContent && fileContent.toLowerCase().includes('@istest')) {
          const testName = ospath
            .basename(apexClass.toString())
            .replace('.cls', '');
          const newApexTestGroup = new ApexTestGroup(testName, apexClass, 1);
          this.apexTestMap.set(testName, newApexTestGroup);
          this.addTests(fileContent, newApexTestGroup);
          ApexTestOutlineProvider.testStrings.add(testName);
          if (this.container) {
            this.container.children.push(newApexTestGroup);
          }
        }
      });
    }
    return this.container;
  }

  private addTests(fileContent: string, apexTestGroup: ApexTestGroup): void {
    // Parse through file and find apex tests
    const regEx = /(@[iI][sS][tT][eE][sS][tT])+/g;
    let match = regEx.exec(fileContent);
    while (match) {
      const ind = match.index;
      // Ignore class heading
      if (ind !== 0) {
        // A test
        const restOfFile = fileContent.slice(match.index);
        const header = restOfFile.slice(0, restOfFile.indexOf('{'));
        const headerParts = header.split(' ');

        // Name is last part of the header, not always the last item though, because could be an empty string ''
        let name = '';
        while (name === '') {
          const headerPart = headerParts.pop();
          if (headerPart && headerPart.includes(')')) {
            name = headerPart;
          }
        }
        name = name.replace('()', ''); // Get rid
        const apexTest = new ApexTest(name, apexTestGroup.file, ind);
        apexTest.name = apexTestGroup.label + '.' + name;
        this.apexTestMap.set(apexTest.name, apexTest);
        apexTestGroup.children.push(apexTest);
      }
      match = regEx.exec(fileContent);
    }
  }

  private deleteFolder(path: string) {
    let files = [];
    if (fs.existsSync(path)) {
      files = fs.readdirSync(path);
      files.forEach((file, index) => {
        const curPath = path + '/' + file;
        if (fs.lstatSync(curPath).isDirectory()) {
          // recurse
          this.deleteFolder(curPath);
        } else {
          // delete file
          fs.unlinkSync(curPath);
        }
      });
      fs.rmdirSync(path);
    }
  }

  public async showErrorMessage(test: Test) {
    let position = test.row;
    let isRow = this.apexTestInfo !== null; // If I derived info from apex-jorje, then it is the row, otherwise it is a positional index
    if (test instanceof ApexTest) {
      const errorMessage = test.errorMessage;
      if (errorMessage && errorMessage !== '') {
        const stackTrace = test.stackTrace;
        position = parseInt(
          stackTrace.substring(
            stackTrace.indexOf('line') + 4,
            stackTrace.indexOf(',')
          ),
          10
        );
        isRow = true;
        channelService.appendLine(
          '-----------------------------------------------------------'
        );
        channelService.appendLine(stackTrace);
        channelService.appendLine(errorMessage);
        channelService.appendLine(
          '-----------------------------------------------------------'
        );
        channelService.showChannelOutput();
      }
    }

    if (test.file) {
      vscode.window.showTextDocument(test.file).then(() => {
        this.eventsEmitter.emit('Show Highlight', position, isRow);
      });
    }
  }

  public async runSingleTest(test: Test) {
    const tmpFolder = this.getTempFolder();
    const builder = new ReadableApexTestRunCodeActionExecutor(
      [test.name],
      false,
      tmpFolder,
      this
    );
    const commandlet = new SfdxCommandlet(
      new SfdxWorkspaceChecker(),
      new EmptyParametersGatherer(),
      builder
    );
    await commandlet.run();
  }

  public updateSelection(position: number, isRow: boolean) {
    if (isRow) {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const line = editor.document.lineAt(position - 1);
        const startPos = new vscode.Position(
          line.lineNumber,
          line.firstNonWhitespaceCharacterIndex
        );
        editor.selection = new vscode.Selection(startPos, line.range.end);
        editor.revealRange(new vscode.Range(startPos, line.range.end)); // Show selection hopefully
      }
    } else {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const pos = editor.document.positionAt(position);
        const line = editor.document.lineAt(pos.line);
        const startPos = new vscode.Position(
          line.lineNumber,
          line.firstNonWhitespaceCharacterIndex
        );
        editor.selection = new vscode.Selection(startPos, line.range.end);
        editor.revealRange(new vscode.Range(startPos, line.range.end));
      }
    }
  }

  public getTempFolder(): string {
    let tempFolder = ospath.resolve(
      vscode.workspace.workspaceFolders![0].uri.path,
      'tmp'
    );
    while (fs.existsSync(tempFolder)) {
      tempFolder = tempFolder + crypto.randomBytes(16).toString('hex');
    }
    return tempFolder;
    //return '/tmp';
  }

  public async runApexTests(): Promise<void> {
    await this.refresh();
    const tmpFolder = this.getTempFolder();
    const builder = new ReadableApexTestRunCodeActionExecutor(
      Array.from(ApexTestOutlineProvider.testStrings.values()),
      false,
      tmpFolder,
      this
    );
    const commandlet = new SfdxCommandlet(
      new SfdxWorkspaceChecker(),
      new EmptyParametersGatherer(),
      builder
    );
    await commandlet.run();
  }

  public readJSONFile(folderName: string) {
    const fullFolderName = ospath.join(
      vscode.workspace.workspaceFolders![0].uri.path,
      folderName
    );
    const jsonSummary = this.getJSONFileOutput(folderName);
    this.UpdateTestsFromJSON(jsonSummary);
    this.onDidChangeTestData.fire();
    this.eventsEmitter.emit('Delete Folder', fullFolderName);
  }

  private getJSONFileOutput(fullFolderName: string): FullTestResult {
    const files = fs.readdirSync(fullFolderName);
    let fileName = files[0];
    for (const file of files) {
      if (
        file !== 'test-result-codecoverage.json' &&
        ospath.extname(file) === '.json' &&
        file.startsWith('test-result')
      ) {
        fileName = file;
      }
    }
    fileName = ospath.join(fullFolderName, fileName);
    const output = fs.readFileSync(fileName).toString();
    const jsonSummary = JSON.parse(output) as FullTestResult;
    return jsonSummary;
  }

  private UpdateTestsFromJSON(jsonSummary: FullTestResult) {
    const groups = new Set<ApexTestGroup>();
    for (const testResult of jsonSummary.tests) {
      const apexGroupName = testResult.FullName.split('.')[0];
      const apexGroup = this.apexTestMap.get(apexGroupName) as ApexTestGroup;
      // Check if new group, if so, set to pass
      if (apexGroup) {
        groups.add(apexGroup);
      }
      const apexTest = this.apexTestMap.get(testResult.FullName) as ApexTest;
      if (apexTest) {
        apexTest.outcome = testResult.Outcome;
        apexTest.updateIcon();
        if (testResult.Outcome === 'Fail') {
          apexTest.errorMessage = testResult.Message;
          apexTest.stackTrace = testResult.StackTrace;
          apexTest.description =
            apexTest.stackTrace + '\n' + apexTest.errorMessage;
        }
      }
    }
    groups.forEach(group => {
      group.updatePassFailLabel();
      group.description = TestSummarizer.summarize(jsonSummary.summary, group);
    });
  }
}

export abstract class Test extends vscode.TreeItem {
  public children = new Array<Test>();
  public description: string;
  public name: string;
  public file: vscode.Uri | null;
  public row: number;

  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    file: vscode.Uri | null,
    row: number
  ) {
    super(label, collapsibleState);
    this.file = file;
    this.row = row;
    this.description = label;
    this.name = label;
    this.command = {
      command: 'sfdx.force.test.view.showError',
      title: 'show error',
      arguments: [this]
    };
  }

  public iconPath = {
    light: LIGHT_BLUE_BUTTON,
    dark: DARK_BLUE_BUTTON
  };

  get tooltip(): string {
    return this.description;
  }

  public updateIcon(outcome: string) {
    if (outcome === 'Pass') {
      // Passed Test
      this.iconPath = {
        light: LIGHT_GREEN_BUTTON,
        dark: DARK_GREEN_BUTTON
      };
    } else if (outcome === 'Fail') {
      // Failed test
      this.iconPath = {
        light: LIGHT_RED_BUTTON,
        dark: DARK_RED_BUTTON
      };
    }
  }

  public abstract contextValue: string;
}

export class ApexTestGroup extends Test {
  public passing: number = 0;

  constructor(label: string, file: vscode.Uri | null, row: number) {
    super(label, vscode.TreeItemCollapsibleState.Expanded, file, row);
  }

  public contextValue = 'apexTestGroup';

  public updatePassFailLabel() {
    this.passing = 0;
    this.children.forEach(child => {
      if ((child as ApexTest).outcome === 'Pass') {
        this.passing++;
      }
    });
    this.label =
      this.name + ' (' + this.passing + '/' + this.children.length + ')';
    if (this.passing === this.children.length) {
      this.updateIcon('Pass');
    } else {
      this.updateIcon('Fail');
    }
  }

  public updateIcon(outcome: string) {
    super.updateIcon(outcome);
    if (outcome === 'Pass') {
      this.children.forEach(child => {
        // Update all the children as well
        child.updateIcon(outcome);
      });
    }
  }
}

export class ApexTest extends Test {
  public errorMessage: string = '';
  public stackTrace: string = '';
  public outcome = 'Not Run';

  constructor(label: string, file: vscode.Uri | null, row: number) {
    super(label, vscode.TreeItemCollapsibleState.None, file, row);
  }

  public updateIcon() {
    super.updateIcon(this.outcome);
    if (this.outcome === 'Pass') {
      this.errorMessage = '';
      this.errorMessage = '';
    }
  }

  public contextValue = 'apexTest';
}

class ReadableApexTestRunCodeActionExecutor extends (ForceApexTestRunCodeActionExecutor as {
  new(test: string, shouldGetCodeCoverage: boolean): any;
}) {
  private outputToJson: string;
  private apexTestOutline: ApexTestOutlineProvider;

  public constructor(
    tests: string[],
    shouldGetCodeCoverage: boolean,
    outputToJson: string,
    apexTestOutline: ApexTestOutlineProvider
  ) {
    super(tests.join(','), shouldGetCodeCoverage);
    this.outputToJson = outputToJson;
    this.apexTestOutline = apexTestOutline;
  }

  public build(data: {}): Command {
    this.builder = this.builder
      .withDescription(
        nls.localize('force_apex_test_run_codeAction_description_text')
      )
      .withArg('force:apex:test:run')
      .withFlag('--tests', this.test)
      .withFlag('--resultformat', 'human')
      .withFlag('--outputdir', this.outputToJson)
      .withFlag('--loglevel', 'error');

    if (this.shouldGetCodeCoverage) {
      this.builder = this.builder.withArg('--codecoverage');
    }
    return this.builder.build();
  }

  public execute(response: ContinueResponse<{}>) {
    const cancellationTokenSource = new vscode.CancellationTokenSource();
    const cancellationToken = cancellationTokenSource.token;
    const execution = new CliCommandExecutor(this.build(response.data), {
      cwd: vscode.workspace.workspaceFolders![0].uri.path
    }).execute(cancellationToken);

    execution.processExitSubject.subscribe(() => {
      this.apexTestOutline.readJSONFile(this.outputToJson);
    });

    channelService.streamCommandOutput(execution);

    if (this.showChannelOutput) {
      channelService.showChannelOutput();
    }

    ProgressNotification.show(execution, cancellationTokenSource);

    notificationService.reportCommandExecutionStatus(
      execution,
      cancellationToken
    );

    taskViewService.addCommandExecution(execution, cancellationTokenSource);
  }
}
