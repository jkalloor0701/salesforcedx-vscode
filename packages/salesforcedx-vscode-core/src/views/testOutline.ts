import * as vscode from 'vscode';
import crypto = require('crypto');
import fs = require('fs');
import ospath = require('path');
import {
  CliCommandExecutor,
  Command
} from '@salesforce/salesforcedx-utils-vscode/out/src/cli';
import {
  ContinueResponse
} from '@salesforce/salesforcedx-utils-vscode/out/src/types';
import { channelService } from '../channels';
import { SfdxCommandlet, SfdxWorkspaceChecker } from '../commands';
import { EmptyParametersGatherer } from '../commands/commands';
import { ForceApexTestRunCodeActionExecutor } from '../commands/forceApexTestRunCodeAction';
import { nls } from '../messages';

const BLUE_BUTTON = ospath.join(__filename, '..', '..', '..', '..', '..', '..', 'resources', 'BlueButton.svg');
const RED_BUTTON = ospath.join(__filename, '..', '..', '..', '..', '..', '..', 'resources', 'RedButton.svg');
const GREEN_BUTTON = ospath.join(__filename, '..', '..', '..', '..', '..', '..', 'resources', 'GreenButton.svg');

export type FullTestResult = {
  summary: TestSummary,
  tests: TestResult[]
};

export type TestSummary = {
  outcome: string,
  testsRan: number,
  passing: number,
  failing: number,
  skipped: number,
  passRate: string,
  failRate: string,
  testStartTime: string,
  testExecutionTime: string,
  testTotalTime: string,
  commandTime: string,
  hostname: string,
  orgId: string,
  username: string,
  testRunId: string,
  userId: string
};

export type TestResult = {
  ApexClass: ApexClass,
  MethodName: string,
  Outcome: string,
  RunTime: number,
  Message: string,
  StackTrace: string,
  FullName: string
};

export type ApexClass = {
  attributes: { type: string },
  Id: string,
  Name: string,
  NamespacPrefix: string
};

export type ApexGroupInfo = {
  name: string,
  outcome: string,
  passed: number,
  total: number,
  summary: TestSummary
};

export class ApexTestOutlineProvider implements vscode.TreeDataProvider<Test> {
  private decorationsDisposable: vscode.Disposable[] = [];
  private _onDidChangeTreeData: vscode.EventEmitter<Test | undefined> = new vscode.EventEmitter<Test | undefined>();
  public readonly onDidChangeTreeData: vscode.Event<Test | undefined> = this._onDidChangeTreeData.event;

  private apexTestMap: Map<string, Test> = new Map<string, Test>();
  private head: Test | null;
  private static testStrings: string[] = new Array<string>();
  private errorLineNum = 0;

  constructor(private path: string, private apexClasses: vscode.Uri[]) {
    this.head = null;
    this.getAllApexTests(this.path);
  }

  public getChildren(element: Test): Thenable<Test[]> {
    if (element) {
      return Promise.resolve(element.children);
    } else {
      if (this.head && this.head.children.length > 0) {
        return Promise.resolve(this.head.children);
      } else {
        const emptyArray = new Array<ApexTest>();
        emptyArray.push(new ApexTest('No tests in folder'));
        return Promise.resolve(emptyArray);
      }
    }
  }

  public refresh() {
    this.head = null; // Reset tests
    this.getAllApexTests(this.path);
    this._onDidChangeTreeData.fire();
  }

  public getTreeItem(element: Test): vscode.TreeItem {
    if (element) {
      return element;
    } else {
      this.getAllApexTests(this.path);
      if (this.head && this.head.children.length > 0) {
        return this.head;
      } else {
        return new ApexTest('No tests in folder');
      }
    }
  }

  private getAllApexTests(path: string): void {
    if (this.head == null) {
      this.head = new ApexTestGroup('ApexTests');
    }
    this.apexClasses.forEach(apexClass => {
      const fileContent = fs.readFileSync(apexClass.fsPath).toString();
      if (fileContent && fileContent.toLowerCase().includes('@istest')) {
        const testName = ospath.basename(apexClass.toString()).replace('.cls', '');
        const newApexTestGroup = new ApexTestGroup(testName);
        this.apexTestMap.set(testName, newApexTestGroup);
        this.addTests(fileContent.toLowerCase(), newApexTestGroup);
        ApexTestOutlineProvider.testStrings.push(testName);
        if (this.head) {
          this.head.children.push(newApexTestGroup);
        }
      }
    });
  }

  private addTests(fileContent: string, apexTestGroup: ApexTestGroup): void {
    // Parse through file and find apex tests
    const testTexts = fileContent.split('@istest');
    // 0 is stuff before @istest and 1 contains class description
    for (let i = 2; i < testTexts.length; i++) {
      const testText = testTexts[i];
      const headerBody = testText.split('{');
      const header = headerBody[0];
      const headerParts = header.split(' ');

      // Name is last part of the header
      let name = '';
      while (name === '') {
        const headerPart = headerParts.pop();
        if (headerPart) {
          name = headerPart;
        }
      }
      name = name.replace('()', '');
      const apexTest = new ApexTest(name);
      // ApexTestOutlineProvider.testStrings.push(apexTestGroup.label + '.' + name);
      this.apexTestMap.set((apexTestGroup.label + '.' + name).toLowerCase(), apexTest);
      apexTestGroup.children.push(apexTest);
    }
  }

  public async showErrorMessage(test: ApexTest) {
    const errorMessage = test.errorMessage;
    if (errorMessage !== '') {
      const stackTrace = test.stackTrace;
      const apexClass = stackTrace.split('.')[1] + '.cls';
      this.errorLineNum = parseInt(stackTrace.substring(stackTrace.indexOf('line') + 4, stackTrace.indexOf(',')), 10);
      const file = (await vscode.workspace.findFiles('**/' + apexClass))[0];
      vscode.window.showTextDocument(file);
      if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.toString() === file.toString()) {
        // Don't need to wait to change
        this.updateDecorations();
      }
      channelService.appendLine('-----------------------------------------------------------');
      channelService.appendLine(stackTrace);
      channelService.appendLine(errorMessage);
      channelService.appendLine('-----------------------------------------------------------');
      channelService.showChannelOutput();
    }
  }

  public updateDecorations() {
    if (this.errorLineNum !== 0) { // here because of an error
      console.log('Error on line:' + this.errorLineNum);
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const startPos = new vscode.Position(this.errorLineNum - 1, 0);
        const endPos = new vscode.Position(this.errorLineNum - 1, 1);
        const newDecoration = { range: new vscode.Range(startPos, endPos) };
        const decoration = this.getErrorDecoration();
        this.decorationsDisposable.push(decoration);
        editor.setDecorations(decoration, [newDecoration]);
      }
    }
    this.errorLineNum = 0;
  }

  public clearDecorations() {
    this.decorationsDisposable.forEach(decoration => {
      decoration.dispose();
    });
  }

  private getTempFolder(): string {
    if (vscode.workspace.rootPath) {
      let tempFolder = ospath.resolve(vscode.workspace.rootPath, 'tmp');
      while (fs.existsSync(tempFolder)) {
        tempFolder = tempFolder + crypto.randomBytes(16).toString('hex');
      }
      return tempFolder;
    }
    return '';
  }

  private getErrorDecoration(): vscode.TextEditorDecorationType {
    const decorationType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: '#FF6666',
      borderColor: '#FF6666'
    });
    return decorationType;
  }

  public async runApexTests(): Promise<void> {
    const tmpFolder = this.getTempFolder();
    const builder = new ReadableApexTestRunCodeActionExecutor(ApexTestOutlineProvider.testStrings, true, tmpFolder, this);
    const commandlet = new SfdxCommandlet(
      new SfdxWorkspaceChecker(),
      new EmptyParametersGatherer(),
      builder);
    await commandlet.run();
  }

  public readJSONFile(folderName: string) {
    if (vscode.workspace.rootPath) {
      const fullFolderName = ospath.resolve(vscode.workspace.rootPath, folderName);
      const files = fs.readdirSync(fullFolderName);
      let fileName = files[0];
      for (const file of files) {
        if (file !== 'test-result-codecoverage.json' && ospath.extname(file) === '.json' && file.startsWith('test-result')) {
          fileName = file;
        }
      }
      fileName = ospath.join(fullFolderName, fileName);
      const output = fs.readFileSync(fileName).toString();
      const jsonSummary = JSON.parse(output) as FullTestResult;
      const groupInfo = new Map<ApexTestGroup, ApexGroupInfo>();
      for (const testResult of jsonSummary.tests) {
        const apexGroupName = testResult.FullName.split('.')[0];
        const apexGroup = this.apexTestMap.get(apexGroupName) as ApexTestGroup;
        // Check if new group, if so, set to pass
        if (apexGroup && !groupInfo.get(apexGroup)) {
          groupInfo.set(apexGroup, { name: apexGroupName, outcome: 'Pass', passed: 0, total: 0, summary: jsonSummary.summary });
        }
        const currentInfo = groupInfo.get(apexGroup);
        let passedTestsIncrease = 1;
        const apexTest = this.apexTestMap.get(testResult.FullName.toLowerCase()) as ApexTest;
        if (apexTest) {
          apexTest.updateIcon(testResult.Outcome);
          if (testResult.Outcome === 'Fail') {
            passedTestsIncrease = 0;
            if (currentInfo) {
              currentInfo.outcome = 'Fail';
            }
            apexTest.errorMessage = testResult.Message;
            apexTest.stackTrace = testResult.StackTrace;
          }
        }
        if (currentInfo) {
          currentInfo.passed = currentInfo.passed + passedTestsIncrease;
          currentInfo.total = currentInfo.total + 1;
          groupInfo.set(apexGroup, currentInfo);
        }
      }
      groupInfo.forEach((info, test) => {
        test.updateIcon(info.outcome);
        test.label = info.name + ' (' + info.passed + '/' + info.total + ')';
        test.description = this.summarize(info.summary);
      });
      this._onDidChangeTreeData.fire();
    }
  }

  private summarize(summary: TestSummary): string {
    let summString = '';
    summString = summString + 'Outcome: ' + summary.outcome + '\n';
    summString = summString + 'Tests Ran: ' + summary.testsRan + '\n';
    summString = summString + 'Passing: ' + summary.passing + '\n';
    summString = summString + 'Failing: ' + summary.failing + '\n';
    summString = summString + 'Skipped: ' + summary.skipped + '\n';
    summString = summString + 'Pass Rate: ' + summary.passRate + '\n';
    summString = summString + 'Fail Rate: ' + summary.failRate + '\n';
    summString = summString + 'Test Start Time: ' + summary.testStartTime + '\n';
    summString = summString + 'Test Execution Time: ' + summary.testExecutionTime + '\n';
    summString = summString + 'Test Total Time: ' + summary.testTotalTime + '\n';
    summString = summString + 'Command Time: ' + summary.commandTime + '\n';
    summString = summString + 'Hostname: ' + summary.hostname + '\n';
    summString = summString + 'Org Id: ' + summary.orgId + '\n';
    summString = summString + 'Username: ' + summary.username + '\n';
    summString = summString + 'Test Run Id: ' + summary.testRunId + '\n';
    summString = summString + 'User Id: ' + summary.userId;
    return summString;
  }

}

export abstract class Test extends vscode.TreeItem {
  public children = new Array<Test>();

  constructor(
    public label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(label, collapsibleState);
  }

  public iconPath = {
    light: BLUE_BUTTON,
    dark: BLUE_BUTTON
  };

  public updateIcon(outcome: string) {
    if (outcome === 'Pass') {
      // Passed Test
      this.iconPath = {
        light: GREEN_BUTTON,
        dark: GREEN_BUTTON
      };

    } else {
      // Failed test
      this.iconPath = {
        light: RED_BUTTON,
        dark: RED_BUTTON
      };
    }
  }

  public abstract contextValue: string;
}

export class ApexTestGroup extends Test {
  public description: string;

  constructor(
    public label: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.description = this.label;
  }

  public contextValue = 'apexTestGroup';

  get tooltip(): string {
    return this.description;
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

  constructor(
    public label: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
  }

  get tooltip(): string {
    return this.label;
  }

  public updateIcon(outcome: string) {
    super.updateIcon(outcome);
    if (outcome === 'Pass') {
      this.errorMessage = '';
      this.errorMessage = '';
    }
  }

  public contextValue = 'apexTest';
}

export class ReadableApexTestRunCodeActionExecutor extends ForceApexTestRunCodeActionExecutor {
  private outputToJson: string;
  private apexTestOutline: ApexTestOutlineProvider;

  public constructor(tests: string[], shouldGetCodeCoverage: boolean, outputToJson: string, apexTestOutline: ApexTestOutlineProvider) {
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

  public async execute(response: ContinueResponse<{}>): Promise<void> {
    const cancellationTokenSource = new vscode.CancellationTokenSource();
    const cancellationToken = cancellationTokenSource.token;
    const execution = new CliCommandExecutor(this.build(response.data), {
      cwd: vscode.workspace.rootPath
    }).execute(cancellationToken);
    this.attachExecution(execution, cancellationTokenSource, cancellationToken);

    execution.processExitSubject.subscribe(status => {
      this.apexTestOutline.readJSONFile(this.outputToJson);
    });
  }

}
