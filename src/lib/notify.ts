import axios from 'axios';
import { HarvestReport } from './harvest-report';
import {
    DISCORD_PING_ROLE_IDS_ON_ERROR,
    DISCORD_WEBHOOK_URL,
    DISCORD_NOTIFY_UNEVENTFUL_HARVEST,
    EXPLORER_CONFIG,
} from './config';
import { rootLogger } from '../util/logger';
import { Blob, File } from 'buffer';
import { bigintFormat } from '../util/bigint';
import { getChainWNativeTokenSymbol } from './addressbook';
import { table } from 'table';
import { asyncResultGet } from '../util/async';
import { serializeReport } from './reports';
import { UnwrapReport } from './unwrap-report';

const logger = rootLogger.child({ module: 'notify' });

type DiscordWebhookParams = {
    content: string;
    username?: string;
    avatar_url?: string;
};

export async function notifyHarvestReport(report: HarvestReport) {
    if (!DISCORD_WEBHOOK_URL) {
        logger.warn({ msg: 'DISCORD_WEBHOOK_URL not set, not sending any discord message' });
        return;
    }

    if (
        report.summary.harvested === 0 &&
        report.summary.statuses.error === 0 &&
        report.summary.statuses.warning === 0
    ) {
        logger.info({ msg: 'All strats were skipped, not reporting', data: report.summary });
        if (!DISCORD_NOTIFY_UNEVENTFUL_HARVEST) {
            return;
        }
    }

    logger.info({ msg: 'notifying harvest for report', data: { chain: report.chain } });

    let reportLevel: string;
    if (report.summary.statuses.error > 0) {
        reportLevel = '🔥 ERROR';
    } else if (report.summary.statuses.warning > 0) {
        reportLevel = '⚠️ WARNING';
    } else {
        reportLevel = 'ℹ️ INFO';
    }

    const stratCountTableStr = table(
        [
            ['strategies', report.summary.totalStrategies],
            ['skipped', report.summary.skipped],
            ['errors', report.summary.statuses.error],
            ['warnings', report.summary.statuses.warning],
            ['silent errors', report.summary.statuses['silent-error']],
            ['harvested', report.summary.harvested],
        ],
        {
            drawHorizontalLine: (lineIndex: number, rowCount: number) => {
                return lineIndex === 0 || lineIndex === 1 || lineIndex === rowCount - 1 || lineIndex === rowCount;
            },
            columns: [{ alignment: 'right' }, { alignment: 'left' }],
        }
    );

    const explorerConfig = EXPLORER_CONFIG[report.chain];

    let warningDetails = '';
    if (report.summary.statuses.warning > 0) {
        for (const stratReport of report.details.filter(d => d.summary.status === 'warning')) {
            if (stratReport.decision && stratReport.decision.warning) {
                const vaultLink = `[${stratReport.vault.id}](<https://app.beefy.finance/vault/${stratReport.vault.id}>)`;
                const stratExplorerLink = explorerConfig.addressLinkTemplate.replace(
                    '${address}',
                    stratReport.vault.strategyAddress
                );
                const stratLink = `[${stratReport.vault.strategyAddress}](<${stratExplorerLink}>)`;
                warningDetails += `- ${vaultLink} (${stratLink}): ${stratReport.decision.notHarvestingReason}\n`;
            }
        }
    }

    const rolePing =
        (report.summary.statuses.error > 0 ||
            report.summary.statuses.warning > 0 ||
            DISCORD_NOTIFY_UNEVENTFUL_HARVEST) &&
        DISCORD_PING_ROLE_IDS_ON_ERROR
            ? DISCORD_PING_ROLE_IDS_ON_ERROR.map(roleId => `<@&${roleId}>`)
            : '';

    const codeSep = '```';
    const params: DiscordWebhookParams = {
        content: `
### Harvest ${reportLevel} for ${report.chain.toLocaleUpperCase()}
${codeSep}
${stratCountTableStr}
${getBalanceReportTable(report)}
${codeSep}
${warningDetails}
${rolePing}`,
    };

    try {
        const reportStr = serializeReport(report, true);
        const reportBlob = new Blob([reportStr], { type: 'application/json' });
        const reportFile = new File([reportBlob], `report_${report.chain}.json`);

        const form = new FormData();
        form.append('payload_json', JSON.stringify(params));
        form.append('file1', reportFile as any);

        await axios.post(DISCORD_WEBHOOK_URL, form);
    } catch (e) {
        logger.error({ msg: 'something went wrong sending discord message', data: { e } });
        logger.trace(e);
    }
}

export async function notifyUnwrapReport(report: UnwrapReport) {
    if (!DISCORD_WEBHOOK_URL) {
        logger.warn({ msg: 'DISCORD_WEBHOOK_URL not set, not sending any discord message' });
        return;
    }

    if (report.summary.success === true && report.summary.unwrapped === false) {
        logger.info({ msg: 'Did not unwrap anything, not reporting', data: report.summary });
        if (!DISCORD_NOTIFY_UNEVENTFUL_HARVEST) {
            return;
        }
    }

    logger.info({ msg: 'notifying unwrap report', data: { chain: report.chain } });

    let reportLevel: string;
    if (!report.summary.success) {
        reportLevel = '🔥 ERROR';
    } else {
        reportLevel = 'ℹ️ INFO';
    }

    const rolePing =
        (!report.summary.success || DISCORD_NOTIFY_UNEVENTFUL_HARVEST) && DISCORD_PING_ROLE_IDS_ON_ERROR
            ? DISCORD_PING_ROLE_IDS_ON_ERROR.map(roleId => `<@&${roleId}>`)
            : '';

    const codeSep = '```';
    const params: DiscordWebhookParams = {
        content: `
### Wnative unwrap ${reportLevel} for ${report.chain.toLocaleUpperCase()}
${report.summary.unwrapped ? codeSep + getBalanceReportTable(report) + codeSep : ''}  
${rolePing}`,
    };

    try {
        const reportStr = serializeReport(report, true);
        const reportBlob = new Blob([reportStr], { type: 'application/json' });
        const reportFile = new File([reportBlob], `report_${report.chain}.json`);

        const form = new FormData();
        form.append('payload_json', JSON.stringify(params));
        form.append('file1', reportFile as any);

        await axios.post(DISCORD_WEBHOOK_URL, form);
    } catch (e) {
        logger.error({ msg: 'something went wrong sending discord message', data: { e } });
        logger.trace(e);
    }
}

function getBalanceReportTable(report: HarvestReport | UnwrapReport) {
    const wnativeSymbol = getChainWNativeTokenSymbol(report.chain);
    const nativeSymbol = wnativeSymbol.slice(1); // remove "w" or "W" prefix

    return table(
        [
            ['', nativeSymbol, wnativeSymbol, `${nativeSymbol} + ${wnativeSymbol}`],
            [
                'before',
                asyncResultGet(report.collectorBalanceBefore, b => bigintFormat(b.balanceWei, 18, 6)) || '??',
                asyncResultGet(report.collectorBalanceBefore, b => bigintFormat(b.wnativeBalanceWei, 18, 6)) || '??',
                asyncResultGet(report.collectorBalanceBefore, b => bigintFormat(b.aggregatedBalanceWei, 18, 6)) || '??',
            ],
            [
                'after',
                asyncResultGet(report.collectorBalanceAfter, b => bigintFormat(b.balanceWei, 18, 6)) || '??',
                asyncResultGet(report.collectorBalanceAfter, b => bigintFormat(b.wnativeBalanceWei, 18, 6)) || '??',
                asyncResultGet(report.collectorBalanceAfter, b => bigintFormat(b.aggregatedBalanceWei, 18, 6)) || '??',
            ],
            [
                'profit',
                bigintFormat(report.summary.nativeGasUsedWei, 18, 6) || '??',
                bigintFormat(report.summary.wnativeProfitWei, 18, 6) || '??',
                bigintFormat(report.summary.aggregatedProfitWei, 18, 6) || '??',
            ],
        ],
        {
            drawHorizontalLine: (lineIndex: number, rowCount: number) => {
                return lineIndex === 0 || lineIndex === 1 || lineIndex === rowCount - 1 || lineIndex === rowCount;
            },
            columns: [{ alignment: 'left' }, { alignment: 'right' }, { alignment: 'right' }, { alignment: 'right' }],
        }
    );
}
