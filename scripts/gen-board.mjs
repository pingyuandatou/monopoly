/**
 * 生成 data/board.json。日常改价钱请直接改 JSON。
 * 40 格。四角是起点、上交所、监狱、深交所。没有公园和免费停车。
 */
import { writeFileSync } from 'node:fs';

function prop(position, name, short, group, groupName, color, price, houseCost, rent) {
  const mortgage = price / 2;
  return {
    position,
    type: 'property',
    name,
    short,
    colorGroup: group,
    groupName,
    color,
    price,
    houseCost,
    mortgage,
    unmortgageCost: Math.round(mortgage * 1.1),
    rent: {
      base: rent[0],
      monopoly: rent[0] * 2,
      oneHouse: rent[1],
      twoHouses: rent[2],
      threeHouses: rent[3],
      fourHouses: rent[4],
      hotel: rent[5],
    },
  };
}

function rail(position, name, short) {
  return {
    position,
    type: 'railroad',
    name,
    short,
    groupName: '铁路',
    color: '#8d7b6a',
    price: 200,
    mortgage: 100,
    unmortgageCost: 110,
    rent: { owned1: 25, owned2: 50, owned3: 100, owned4: 200 },
  };
}

const exchange = (position, name, short) => ({
  position,
  type: 'exchange',
  name,
  short,
  color: '#d64545',
  description: '按你现在的现金抽一次行情。涨停赚一成，疯牛赚两成，跌停亏一成，熊市亏两成。亏掉的钱进银行。',
});

const corners = {
  0: { position: 0, type: 'go', name: '起点', short: '起点', color: '#e0b15a', description: '经过或停在这里，领取起点薪水。' },
  10: exchange(10, '上交所', '上交所'),
  20: { position: 20, type: 'jail', name: '监狱', short: '监狱', color: '#8a7364', description: '马上选择：交保释金，下一回合照常走；或者跳过下一回合。停走期间别人停在你的地上不用交租。' },
  30: exchange(30, '深交所', '深交所'),
};

const groups = [
  ['old', '老城', '#a56a45', 50, [[1, '老城南巷', '南巷', 60, [2, 10, 30, 90, 160, 250]], [2, '老城北巷', '北巷', 60, [4, 20, 60, 180, 320, 450]], [3, '老城茶馆', '茶馆', 80, [6, 30, 90, 270, 400, 550]], [4, '钟鼓楼', '钟楼', 80, [6, 30, 90, 270, 400, 550]]]],
  ['coast', '滨海', '#3aa0c8', 50, [[6, '青岛栈桥', '栈桥', 100, [6, 30, 90, 270, 400, 550]], [7, '大连星海', '星海', 100, [6, 30, 90, 270, 400, 550]], [8, '天津五大道', '五大道', 120, [8, 40, 100, 300, 450, 600]], [9, '威海刘公岛', '刘公岛', 130, [9, 45, 120, 360, 520, 670]]]],
  ['jiangnan', '江南', '#e25b8a', 100, [[11, '南京夫子庙', '夫子庙', 140, [10, 50, 150, 450, 625, 750]], [12, '杭州西湖', '西湖', 140, [10, 50, 150, 450, 625, 750]], [13, '苏州园林', '园林', 160, [12, 60, 180, 500, 700, 900]], [14, '扬州瘦西湖', '瘦西湖', 160, [12, 60, 180, 500, 700, 900]]]],
  ['southwest', '西南', '#e08a2f', 100, [[16, '成都宽窄巷', '宽窄巷', 180, [14, 70, 200, 550, 750, 950]], [17, '重庆洪崖洞', '洪崖洞', 180, [14, 70, 200, 550, 750, 950]], [18, '长沙橘子洲', '橘子洲', 180, [14, 70, 200, 550, 750, 950]], [19, '昆明滇池', '滇池', 200, [16, 80, 220, 600, 800, 1000]]]],
  ['northwest', '西北', '#d4534a', 150, [[21, '西安城墙', '城墙', 220, [18, 90, 250, 700, 875, 1050]], [22, '兰州黄河', '黄河', 220, [18, 90, 250, 700, 875, 1050]], [23, '敦煌月牙泉', '月牙泉', 240, [20, 100, 300, 750, 925, 1100]], [24, '乌市红山', '红山', 240, [20, 100, 300, 750, 925, 1100]]]],
  ['lingnan', '岭南', '#e0b106', 150, [[26, '广州塔', '广州塔', 260, [22, 110, 330, 800, 975, 1150]], [27, '深圳湾', '深圳湾', 260, [22, 110, 330, 800, 975, 1150]], [28, '珠海横琴', '横琴', 280, [24, 120, 360, 850, 1025, 1200]], [29, '厦门鼓浪屿', '鼓浪屿', 290, [25, 125, 375, 875, 1060, 1240]]]],
  ['shanghai', '上海', '#2f9e6b', 200, [[31, '上海外滩', '外滩', 300, [26, 130, 390, 900, 1100, 1275]], [32, '上海豫园', '豫园', 300, [26, 130, 390, 900, 1100, 1275]], [33, '陆家嘴', '陆家嘴', 320, [28, 150, 450, 1000, 1200, 1400]], [34, '武康路', '武康路', 320, [28, 150, 450, 1000, 1200, 1400]]]],
  ['beijing', '北京', '#3b6cff', 200, [[36, '北京故宫', '故宫', 350, [35, 175, 500, 1100, 1300, 1500]], [37, '颐和园', '颐和园', 350, [35, 175, 500, 1100, 1300, 1500]], [38, '天坛', '天坛', 400, [50, 200, 600, 1400, 1700, 2000]], [39, '北京天安门', '天安门', 400, [50, 200, 600, 1400, 1700, 2000]]]],
];

const squares = Array.from({ length: 40 }, (_, position) => corners[position] ?? null);
for (const [group, groupName, color, houseCost, list] of groups) {
  for (const [position, name, short, price, rent] of list) {
    squares[position] = prop(position, name, short, group, groupName, color, price, houseCost, rent);
  }
}
squares[5] = rail(5, '京沪铁路', '京沪');
squares[15] = rail(15, '京广铁路', '京广');
squares[25] = rail(25, '陇海铁路', '陇海');
squares[35] = rail(35, '青藏铁路', '青藏');

if (squares.some((sq) => !sq)) throw new Error('棋盘有空格');
const board = {
  _comment: '40 格。0 起点、10 上交所、20 监狱、30 深交所。没有公园、免费停车、机会、命运和税。',
  squares,
};
writeFileSync(new URL('../data/board.json', import.meta.url), `${JSON.stringify(board, null, 2)}\n`);
console.log('wrote', squares.length, 'squares');
